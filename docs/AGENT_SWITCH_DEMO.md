# Agent Switch Demo

`scripts/demo-agent-switch.ts` 是 Agent Switch 的可重复运行演示脚本。它直接调用项目现有的 `Agent`、控制数据库、迁移、`job_events` 和 `agent_attempts`，但使用本地脚本化 Provider，因此不需要真实 LLM 密钥，也不会产生模型费用。

## 运行方式

在项目根目录完成依赖安装后执行：

```powershell
npx tsx scripts/demo-agent-switch.ts
```

## 演示流程

1. Builder 在 attempt 0 中连续发生两次工具失败。
2. 系统达到失败阈值，生成 JSON 交接快照。
3. Agent Switch 将任务从 `builder` 交给 `repair-1`。
4. Repair Agent 使用相同任务状态继续执行并成功完成。
5. 脚本读取数据库，验证任务、切换事件和 attempt 生命周期。

## 通过标准

终端最后应显示：

```text
DEMO PASS：Builder 失败后，repair-1 自动接管并成功完成。
```

同时应满足：

- `status = succeeded`
- `currentAgent = repair-1`
- `switchCount = 1`
- attempt 0 为 `switched`
- attempt 1 为 `succeeded`
- `agent_switch` 原因为 `consecutive_tool_failures`

演示结束后会关闭服务并删除临时数据库，不会写入项目正式数据目录。
