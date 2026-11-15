# Agent Switch

Agent Switch keeps recovery work inside the same durable job. It does not
replace project ownership checks, file hashes, tool allowlists, isolated
execution, or the final build/test/preview success gate.

## Triggers

- Consecutive failed tool calls reach `AGENT_SWITCH_FAILURE_THRESHOLD`.
- The same normalized failure fingerprint repeats even when an unrelated
  successful inspection occurs between failures.
- The model provider throws a retryable request or response error.
- The current attempt reaches its step budget and the global hard limit still
  leaves room for a recovery attempt.

Rate limits, timeouts, invalid responses and provider 5xx errors may switch.
Authentication failures, missing models, missing configuration and insecure
provider URLs fail directly. Missing Docker isolation remains an environment
block and does not consume a switch.

## Handoff

The platform records an `agent_switch` job event and starts a fresh recovery
context containing bounded, valid JSON state: the original requirement,
project and plan, validation flags, explicit module references, the switch
reason, and recent durable job events. Repository text and event payloads are
explicitly treated as untrusted data.

The recovery Agent must inspect current files and logs, use current
`expectedHash` values, make the smallest safe repair, and rerun build, tests,
and preview after mutation. A switch never restores stale validation evidence.

## Provider behavior

Without fallback settings, recovery uses the primary provider with a fresh
repair context. Set `LLM_FALLBACK_MODEL` to use a separate recovery model.
`LLM_FALLBACK_BASE_URL` and `LLM_FALLBACK_API_KEY` are optional and fall back
to the primary endpoint and key.

## Limits and observability

`AGENT_MAX_SWITCHES` defaults to 2 and is capped at 3. Every switch increments
`jobs.agent_attempt` and `jobs.switch_count`, updates `jobs.current_agent`, and
adds an append-only `agent_switch` event with the reason and selected provider
metadata. Secrets are never included. The job detail view shows the active
recovery Agent and switch count.

`agent_attempts` records each builder or recovery attempt with its provider,
model, trigger, lifecycle status and timestamps. Job state, attempt lifecycle
and the switch event are committed in one database transaction so a partial
handoff is not exposed.
