# Subagents setup

当前这套全局 subagents 配置用于把低价值、只读、可压缩的工作下沉，减少主线程上下文污染。

## 当前角色

- `hunter`：代码探索、找入口、追调用链、定位相关文件。
- `mage`：查文档、核对配置、整理外部或历史信息。
- `paladin`：在已有方案、diff 或改动后做独立复核。

## 相关文件

- `agents/hunter.toml`
- `agents/mage.toml`
- `agents/paladin.toml`
- `skills/hunter-delegation/`
- `skills/mage-delegation/`
- `skills/paladin-delegation/`
- `AGENTS.md` 中的 `## Subagents` 段落
- `config.toml` 中的 `[agents]` 段落

## 清理方式

如需完整移除这套配置：

1. 删除以上 3 个 `agents/*.toml` 文件。
2. 删除以上 3 个 `skills/*-delegation/` 目录。
3. 从 `AGENTS.md` 中删除 `## Subagents` 段落。
4. 如不再需要全局限制，可从 `config.toml` 中删除：

```toml
[agents]
max_threads = 3
max_depth = 1
```

## 备注

- 当前主线程仍使用 `gpt-5.5`。
- `hunter` 与 `mage` 使用 `deepseek-v4-flash`。
- `paladin` 使用 `gpt-5.4`。
- Codex 只有在用户明确要求使用 subagent 时才会实际派发。
