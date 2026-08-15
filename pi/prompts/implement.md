---
description: [scout(opencode-go/deepseek-v4-flash) -> planner(opencode-go/glm-5.2) -> worker(opencode-go/deepseek-v4-pro)] 完整实现流程：侦察→规划→实施
---
使用 subagent 工具的 chain 参数执行此工作流：

1. 第一步：使用 "scout" agent 查找与 {{$@}} 相关的所有代码
2. 第二步：使用 "planner" agent，基于前一步的上下文（使用 {previous} 占位符）为 "{{$@}}" 创建实现计划
3. 第三步：使用 "worker" agent，基于前一步的计划（使用 {previous} 占位符）进行实现

以链式方式执行，通过 {previous} 在各步骤间传递输出。
