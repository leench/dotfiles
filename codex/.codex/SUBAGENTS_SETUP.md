# Subagents setup

这套全局 subagents 配置把侦察、规划、实施和复核分开，减少主线程上下文污染并限制写入范围。

## 当前角色

- `scout`：只读代码库侦察、入口定位、调用链追踪和证据压缩；`deepseek-v4-flash`，`high`。
- `worker`：按已批准方向实施窄范围修改并验证；`deepseek-v4-flash`，`max`，`workspace-write`。
- `planner`：只读需求分析、文件定位和可执行实施计划；`gpt-5.6-sol`，`high`。
- `reviewer`：只读 diff、计划、方案和回归风险审查；`gpt-5.6-terra`，`high`。

## 相关文件

- `agents/scout.toml`
- `agents/worker.toml`
- `agents/planner.toml`
- `agents/reviewer.toml`
- `config.toml` 中的 `[agents]` 段落

## 运行约束

- `scout`、`planner`、`reviewer` 不修改文件。
- `worker` 只修改明确分配的范围，不自行扩大产品或架构决策。
- 当前全局并发上限仍为 `max_threads = 3`，深度上限为 `max_depth = 1`。
- Codex 只有在用户明确要求或适用的项目/skill 指令要求时才会实际派发 subagent。
