import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createControl } from "../server/control.js";
import { Agent, type LlmMessage, type LlmProvider } from "../server/agent.js";

const colors = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  blue: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  dim: "\u001b[2m",
};

function toolCall(name: string, args: unknown): LlmMessage {
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

class DemoProvider implements LlmProvider {
  private step = 0;

  async complete(messages: LlmMessage[]): Promise<LlmMessage> {
    this.step += 1;
    if (this.step === 1) {
      console.log(`${colors.red}1. Builder 请求未授权工具 execShell，失败${colors.reset}`);
      return toolCall("execShell", { command: "whoami" });
    }
    if (this.step === 2) {
      console.log(`${colors.red}2. Builder 再次请求越界读取，达到切换阈值${colors.reset}`);
      return toolCall("readProjectFiles", { path: "../outside" });
    }
    if (this.step === 3) {
      const handoffText = messages.at(-1)?.content?.split("\n").slice(1).join("\n");
      const handoff = JSON.parse(handoffText || "{}");
      console.log(
        `${colors.yellow}3. Agent Switch：${handoff.previousAgent} → ${handoff.nextAgent}${colors.reset}`,
      );
      console.log(
        `${colors.dim}   原因：${handoff.reason}；交接快照 JSON 校验成功${colors.reset}`,
      );
      return toolCall("createPreview", {});
    }
    console.log(`${colors.green}4. Repair Agent 完成预览并返回成功结果${colors.reset}`);
    return { role: "assistant", content: "Recovered after automatic handoff" };
  }
}

async function main() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "atlas-switch-demo-"));
  const control = await createControl({ dataDir });
  try {
    console.log(`\n${colors.bold}${colors.blue}ATLAS Agent Switch · 真实运行 Demo${colors.reset}`);
    console.log(`${colors.dim}使用真实 Agent、数据库迁移、事件记录和 attempt 生命周期${colors.reset}\n`);

    const registration = await control.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: `agent-switch-${randomUUID()}@demo.local`,
        password: "DemoPassword123",
      },
    });
    const user = registration.json().user;
    const created = await control.projects.create(
      user.id,
      {
        name: "Agent Switch Demo",
        description: "Deterministic end-to-end Agent Switch demonstration",
        kind: "events",
        modules: ["events"],
        features: [],
        primaryColor: "blue",
      },
      "Agent Switch Demo",
    );
    const jobId = randomUUID();
    await control.db.query(
      "INSERT INTO jobs(id,project_id,owner_id,input,mode,status) VALUES($1,$2,$3,$4,'demo','queued')",
      [
        jobId,
        created.project.id,
        user.id,
        "Create a safe preview and recover automatically if the builder stalls",
      ],
    );

    const agent = new Agent(
      control.projects,
      control.deployments,
      new DemoProvider(),
      { maxSwitches: 1 },
    );
    await agent.run(jobId);

    const job = await agent.get(jobId, user.id);
    const switches = (
      await control.db.query<{
        payload: {
          from: string;
          to: string;
          reason: string;
          attempt: number;
          switchCount: number;
        };
      }>(
        "SELECT payload FROM job_events WHERE job_id=$1 AND type='agent_switch' ORDER BY id",
        [jobId],
      )
    ).rows;
    const attempts = (
      await control.db.query<{
        attempt: number;
        agent: string;
        trigger: string;
        status: string;
      }>(
        "SELECT attempt,agent,trigger,status FROM agent_attempts WHERE job_id=$1 ORDER BY attempt",
        [jobId],
      )
    ).rows;

    console.log(`\n${colors.bold}真实持久化结果${colors.reset}`);
    console.table({
      status: job.status,
      currentAgent: job.current_agent,
      switchCount: job.switch_count,
      agentAttempt: job.agent_attempt,
    });
    console.table(attempts);
    console.log("agent_switch event:", JSON.stringify(switches[0]?.payload, null, 2));

    const passed =
      job.status === "succeeded" &&
      job.current_agent === "repair-1" &&
      job.switch_count === 1 &&
      attempts[0]?.status === "switched" &&
      attempts[1]?.status === "succeeded";
    if (!passed) throw new Error("Agent Switch demo assertions failed");
    console.log(`\n${colors.bold}${colors.green}DEMO PASS：Builder 失败后，repair-1 自动接管并成功完成。${colors.reset}\n`);
  } finally {
    await control.app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
