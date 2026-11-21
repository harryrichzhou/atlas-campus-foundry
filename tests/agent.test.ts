import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createControl } from "../server/control.js";
import { Agent, type LlmProvider, type LlmMessage } from "../server/agent.js";
import { AppError } from "../packages/contracts/src/index.js";

class ScriptedContractProvider implements LlmProvider {
  constructor(private replies: LlmMessage[]) {}
  async complete() {
    const reply = this.replies.shift();
    if (!reply) throw new Error("Unexpected provider call");
    return reply;
  }
}
function call(name: string, args: unknown): LlmMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
test("Agent contract-only provider: real tools, durable trace, stale preview rejected, repair budget enforced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "foundry-agent-"));
  const c = await createControl({ dataDir: root });
  try {
    const registered = await c.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "agent@test.example", password: "AgentPassword123" },
    });
    const user = registered.json().user;
    const project = await c.projects.create(
      user.id,
      {
        name: "Agent contract app",
        description: "Explicit scripted provider test, not live LLM",
        kind: "events",
        modules: ["events"],
        features: [],
        primaryColor: "green",
      },
      "Contract test",
    );
    async function queued(input: string) {
      const id = randomUUID();
      await c.db.query(
        "INSERT INTO jobs(id,project_id,owner_id,input,mode,status) VALUES($1,$2,$3,$4,'contract-test','queued')",
        [id, project.project.id, user.id, input],
      );
      return id;
    }
    const first = await queued("Check stale preview");
    const agent = new Agent(
      c.projects,
      c.deployments,
      new ScriptedContractProvider([
        call("createPreview", {}),
        call("selectModules", { moduleIds: ["events", "search"] }),
        { role: "assistant", content: "Scripted completion" },
      ]),
    );
    await agent.run(first);
    assert.equal((await agent.get(first, user.id)).status, "needs_attention");
    const events = (
      await c.db.query<{ type: string; payload: { name: string } }>(
        "SELECT type,payload FROM job_events WHERE job_id=$1 ORDER BY id",
        [first],
      )
    ).rows;
    assert.ok(
      events.some(
        (e) => e.type === "tool_result" && e.payload.name === "createPreview",
      ),
    );
    const second = await queued("Invalid tool requests must stop");
    const failing = new Agent(
      c.projects,
      c.deployments,
      new ScriptedContractProvider([
        call("execShell", { command: "whoami" }),
        call("readProjectFiles", { path: "../outside" }),
        call("writeProjectFiles", { path: ".env", content: "bad" }),
      ]),
    );
    await failing.run(second);
    assert.equal((await failing.get(second, user.id)).status, "failed");
    const stored = (
      await c.db.query<{ error: string }>(
        "SELECT error FROM jobs WHERE id=$1",
        [second],
      )
    ).rows[0];
    assert.match(stored.error, /Repair budget exhausted/);
    const switched = await queued("Recover the same job with a fresh Agent");
    const switchable = new Agent(
      c.projects,
      c.deployments,
      new ScriptedContractProvider([
        call("execShell", { command: "whoami" }),
        call("readProjectFiles", { path: "../outside" }),
        call("createPreview", {}),
        { role: "assistant", content: "Recovered after handoff" },
      ]),
      { maxSwitches: 1 },
    );
    await switchable.run(switched);
    const switchedJob = await switchable.get(switched, user.id);
    assert.equal(switchedJob.status, "succeeded");
    assert.equal(switchedJob.switch_count, 1);
    assert.equal(switchedJob.current_agent, "repair-1");
    const handoffs = (
      await c.db.query<{ payload: { reason: string; to: string } }>(
        "SELECT payload FROM job_events WHERE job_id=$1 AND type='agent_switch'",
        [switched],
      )
    ).rows;
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].payload.reason, "consecutive_tool_failures");
    assert.equal(handoffs[0].payload.to, "repair-1");
    const attempts = (
      await c.db.query<{ attempt: number; status: string }>(
        "SELECT attempt,status FROM agent_attempts WHERE job_id=$1 ORDER BY attempt",
        [switched],
      )
    ).rows;
    assert.deepEqual(attempts, [
      { attempt: 0, status: "switched" },
      { attempt: 1, status: "succeeded" },
    ]);
    const repeatedFailure = await queued(
      "Recover when the same failure repeats around a successful inspection",
    );
    let repeatedStep = 0,
      handoffWasValidJson = false;
    const repeatedAgent = new Agent(
      c.projects,
      c.deployments,
      {
        async complete(messages) {
          if (repeatedStep++ === 0)
            return call("execShell", { command: "whoami" });
          if (repeatedStep === 2)
            return call("searchModules", { query: "events" });
          if (repeatedStep === 3)
            return call("execShell", { command: "whoami" });
          if (repeatedStep === 4) {
            const handoff = messages
              .at(-1)
              ?.content?.split("\n")
              .slice(1)
              .join("\n");
            assert.ok(handoff);
            JSON.parse(handoff);
            handoffWasValidJson = true;
            return call("createPreview", {});
          }
          return { role: "assistant", content: "Recovered repeated failure" };
        },
      },
      { maxSwitches: 1 },
    );
    await repeatedAgent.run(repeatedFailure);
    assert.equal(
      (await repeatedAgent.get(repeatedFailure, user.id)).status,
      "succeeded",
    );
    assert.equal(handoffWasValidJson, true);
    const repeatedHandoff = (
      await c.db.query<{ payload: { reason: string } }>(
        "SELECT payload FROM job_events WHERE job_id=$1 AND type='agent_switch'",
        [repeatedFailure],
      )
    ).rows;
    assert.equal(
      repeatedHandoff[0].payload.reason,
      "repeated_failure_fingerprint",
    );
    const rateLimited = await queued("Recover from a retryable provider error");
    let rateStep = 0;
    const rateAgent = new Agent(
      c.projects,
      c.deployments,
      {
        async complete() {
          if (rateStep++ === 0)
            throw new AppError(502, "LLM_RATE_LIMITED", "rate limited");
          if (rateStep === 2) return call("createPreview", {});
          return { role: "assistant", content: "Recovered provider" };
        },
      },
      { maxSwitches: 1 },
    );
    await rateAgent.run(rateLimited);
    assert.equal(
      (await rateAgent.get(rateLimited, user.id)).status,
      "succeeded",
    );
    assert.equal(
      (
        await c.db.query<{ payload: { reason: string } }>(
          "SELECT payload FROM job_events WHERE job_id=$1 AND type='agent_switch'",
          [rateLimited],
        )
      ).rows[0].payload.reason,
      "provider_error",
    );
    const badCredentials = await queued(
      "Do not switch when provider credentials are invalid",
    );
    const authAgent = new Agent(
      c.projects,
      c.deployments,
      {
        async complete() {
          throw new AppError(502, "LLM_AUTH_FAILED", "bad credentials");
        },
      },
      { maxSwitches: 1 },
    );
    await authAgent.run(badCredentials);
    assert.equal(
      (await authAgent.get(badCredentials, user.id)).status,
      "failed",
    );
    assert.equal(
      (
        await c.db.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM job_events WHERE job_id=$1 AND type='agent_switch'",
          [badCredentials],
        )
      ).rows[0].count,
      0,
    );
    const third = await queued(
      "Write actual custom source without executing it",
    );
    const custom = new Agent(
      c.projects,
      c.deployments,
      new ScriptedContractProvider([
        call("generateCustomFeature", {
          files: [
            {
              path: "src/feature.ts",
              expectedHash: null,
              content:
                "export function ordering(position:number){ return position + 1; }",
            },
          ],
          rationale: "Contract fixture exercises actual file tool",
        }),
        { role: "assistant", content: "Source written; no execution evidence" },
      ]),
    );
    await custom.run(third);
    assert.equal((await custom.get(third, user.id)).status, "needs_attention");
    assert.match(
      await c.projects.read(project.project.id, user.id, "src/feature.ts"),
      /ordering/,
    );
    const largeText = "// large source\n" + "x".repeat(65000);
    const written = await c.projects.write(
      project.project.id,
      user.id,
      "src/large.txt",
      largeText,
    );
    const fourth = await queued(
      "Read a large file without truncating its hash",
    );
    let readerStep = 0;
    const reader = new Agent(c.projects, c.deployments, {
      async complete(messages) {
        if (readerStep++ === 0)
          return call("readProjectFiles", { path: "src/large.txt" });
        const output = JSON.parse(messages.at(-1)!.content!);
        assert.equal(output.hash, written.hash);
        assert.equal(output.content, largeText.slice(0, 8000));
        assert.equal(output.totalChars, largeText.length);
        assert.equal(output.nextOffset, 8000);
        return {
          role: "assistant",
          content: "Contract fixture read first page",
        };
      },
    });
    await reader.run(fourth);
    const nextPage = (await reader.execute(
      await reader.get(fourth, user.id),
      "readProjectFiles",
      { path: "src/large.txt", offset: 8000 },
    )) as { content: string; hash: string };
    assert.equal(nextPage.hash, written.hash);
    assert.equal(nextPage.content, largeText.slice(8000, 16000));
    const clean = await c.projects.create(
      user.id,
      project.project.spec,
      "Partial-write regression",
    );
    const fifth = await queued(
      "A failed bulk write must invalidate prior preview",
    );
    await c.db.query("UPDATE jobs SET project_id=$2 WHERE id=$1", [
      fifth,
      clean.project.id,
    ]);
    const partial = new Agent(
      c.projects,
      c.deployments,
      new ScriptedContractProvider([
        call("createPreview", {}),
        call("generateCustomFeature", {
          files: [
            {
              path: "src/partial.ts",
              content: "export const partial = true;",
              expectedHash: null,
            },
            {
              path: "README.md",
              content: "Would overwrite another revision",
              expectedHash: null,
            },
          ],
          rationale: "Exercise real partial write and stale validation",
        }),
        {
          role: "assistant",
          content: "Fixture must not report successful completion",
        },
      ]),
    );
    await partial.run(fifth);
    const partialJob = await partial.get(fifth, user.id);
    assert.equal(partialJob.status, "needs_attention");
    const trace = (
      await c.db.query<{
        payload: {
          result: { status?: string; code?: string; message?: string };
        };
      }>(
        "SELECT payload FROM job_events WHERE job_id=$1 AND type='tool_result' ORDER BY id",
        [fifth],
      )
    ).rows;
    assert.equal(trace[0].payload.result.status, "running");
    assert.equal(trace[1].payload.result.code, "FILE_CONFLICT");
    assert.match(
      trace[1].payload.result.message!,
      /persisted files: src\/partial.ts/,
    );
    assert.equal(
      (
        await c.db.query<{ result: { previewPassed: boolean } }>(
          "SELECT result FROM jobs WHERE id=$1",
          [fifth],
        )
      ).rows[0].result.previewPassed,
      false,
    );
    assert.match(
      await c.projects.read(clean.project.id, user.id, "src/partial.ts"),
      /partial = true/,
    );
  } finally {
    await c.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
