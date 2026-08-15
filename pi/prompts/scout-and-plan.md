---
description: [scout(opencode-go/deepseek-v4-flash) -> planner(opencode-go/glm-5.2)] 仅侦察与规划，不执行实现
---
使用 subagent 工具的 chain 参数执行此工作流：

1. 第一步：使用 "scout" agent 查找与 {{$@}} 相关的所有代码
2. 第二步：使用 "planner" agent，基于前一步的上下文（使用 {previous} 占位符）为 "{{$@}}" 创建实现计划

以链式方式执行，通过 {previous} 在各步骤间传递输出。不要实现——只返回计划。
