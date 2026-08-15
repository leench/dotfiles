---
description: [worker(opencode-go/deepseek-v4-pro) -> reviewer(opencode-go/deepseek-v4-pro) -> worker(opencode-go/deepseek-v4-pro)] 实现→审查→修复
---
使用 subagent 工具的 chain 参数执行此工作流：

1. 第一步：使用 "worker" agent 实现：{{$@}}
2. 第二步：使用 "reviewer" agent 审查前一步的实现（使用 {previous} 占位符）
3. 第三步：使用 "worker" agent 根据审查反馈进行修复（使用 {previous} 占位符）

以链式方式执行，通过 {previous} 在各步骤间传递输出。
