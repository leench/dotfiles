# agy-knot

将 **Antigravity CLI (`agy`)** 接入 **Knot Agent Session WebSocket** 的独立桥接工具：不依赖 Herdr 或终端复用器，单条 WS 连接接收已加入 Room 的实时事件并写入本地收件箱，可选地将结构化 `mention.execute` 串行投递给无头 `agy -p` 会话执行。

## 做什么 / 不做什么

- **1:1 稳定身份绑定**：每个 profile 持久绑定一对 `(agent_session_id, agy_conversation_id)`。首次启动未绑定时自动调用 `POST /api/agent/sessions` 创建并绑定（区分确定拒绝与结果未知，避免重复造会话）；也可用 `agy-knot connect <id>` 绑定已有会话。
- **不重做 MCP**：本工具只接收事件索引与授权信号，不拉取消息正文、不发消息、不碰审批；正文读取（`get_messages`）与回复（`send_message`）全部由 `agy` 自身配置的 Knot MCP 完成。
- **默认保守**：默认不开启 `--auto-execute`，事件只写入本地收件箱（`inbox.jsonl`）；开启后也**仅**对启用基线（`ready.latest_event_id`）之后的新结构化 `mention.execute` 串行拉起 `agy`，普通 `room.message`、文本 `@`、`mention.pending` 不会触发执行。
- **单连接与防重发**：通过 `fcntl.flock` 防止本机多实例抢同一状态目录；服务端返回 `4409 SESSION_ALREADY_CONNECTED` 或 `4401/4403` 时直接退出不重试；`4408/1011` 与网络断开按指数退避重连并用 `/api/agent-events` 游标补拉；进程崩溃残留的 `running` 事件重启后不自动重发，需人工用 `agy-knot trigger <event_id>` 确认。

## 依赖与安装

- Python >= 3.11，运行时依赖：`websockets>=15.0`、`python-socks[asyncio]>=2.4`（兼容本机 SOCKS 代理环境）
- 本机已安装并登录 Antigravity CLI (`agy`)，且已在 `~/.gemini/config/mcp_config.json` 配置好 Knot MCP

通过 dotfiles 安装：

```bash
cd ~/dotfiles
./install.sh agy-knot
```

或独立安装：

```bash
uv tool install --editable ~/dotfiles/agy-knot
```

## 凭证与配置

凭证解析优先级：
1. 环境变量 `KNOT_AGENT_TOKEN`（若已设置但为空/含空白字符，直接报错不回退）
2. 自动回退读取 `~/.gemini/config/mcp_config.json` 中的 `mcpServers.knot`（要求同源、未禁用、Bearer 头）

Token 仅放进 `Authorization: Bearer ...` 请求头，不写入 URL、命令行参数、收件箱、状态文件或日志。

## 常用命令

```bash
# 1) 绑定已有 Knot 会话（可选；不绑定则 run 时自动创建）
agy-knot connect 164 --profile gzstv

# 2) 仅监听并写入收件箱（默认不自动执行）
agy-knot run --profile gzstv --cwd /path/to/workspace

# 3) 开启 mention.execute 自动执行（默认 --mode auto --sandbox --print-timeout 10m）
agy-knot run --profile gzstv --cwd /path/to/workspace --auto-execute

# 4) 查看绑定、游标与投递统计
agy-knot status --profile gzstv

# 5) 查看本地收件箱
agy-knot inbox --profile gzstv --limit 20

# 6) 手动将某条事件交给 agy 读取或处理
agy-knot trigger 42 --profile gzstv --read-only

# 7) 安装 Antigravity SessionStart hook（启动 agy 会话时自动在后台拉起，已有实例则跳过）
agy-knot install-hook --profile gzstv --auto-execute
```

## 随 `agy` 自动启动（`SessionStart` Hook）

执行 `agy-knot install-hook --profile <name> [--auto-execute]` 会在 `~/.gemini/config/hooks.json` 中合并写入 `agy-knot` 的 `SessionStart` hook（不覆盖 `herdr` 等已有 hook）：

- 每次启动 `agy` 会话并发出首条消息前触发；
- 若后台该 profile 已在运行（`fcntl.flock` 锁存在），直接跳过不重复拉起；
- `agy-knot` 自己拉起的无头 `agy -p` 子进程会自动带 `AGY_KNOT_CHILD=1`，hook 检测到后直接退出，避免递归；
- 后台日志输出到 `~/.knot/agy-knot/<profile>/daemon.log`。

## 权限与安全边界

- 后台拉起 `agy` 时默认启用 `--mode auto --sandbox`，并通过单次会话 `--settings` 自动放行最小化的 Knot MCP 工具白名单（`get_messages`、`get_room_messages`、`get_room`、`list_rooms`、`get_attachment`，非只读模式再加 `send_message`），不修改全局 `settings.json`；可用 `--no-allow-knot-mcp` 关闭该自动放行。
- 其他需人工确认的高危操作仍会被 `agy` soft-deny（不会卡死等待输入）；如需放行额外工具，建议在 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 中做最小化白名单授权，谨慎使用 `--dangerously-skip-permissions`。
- Room 消息正文、摘要和附件均视为不可信输入；`mention.execute` 仅代表主人允许考虑执行，不代表绕过工具安全边界。

## 已验证 / 未验证

已验证（真实 Knot + Antigravity CLI 联调）：
- 从 `~/.gemini/config/mcp_config.json` 自动复用同源 Bearer 凭证（不落盘、不打印），在 macOS SOCKS 代理环境下建立 WS 连接；
- 接收真实 Room 的 `room.message`（仅入收件箱）与结构化 `mention.execute`（串行拉起无头 `agy -p` 并持久化绑定后台 `conversation_id`）；
- 无头 `agy` 在 `--mode auto --sandbox` + 单次会话 `--settings` Knot MCP 最小白名单下，通过 `get_messages` 读取正文并通过 `send_message` 回复到原 Room。

未验证：
- 长时间心跳、跨网络抖动、全部 `440x` 关闭码（如 `4409` / `4408`）及批量并发到达的真实压测；
- 其他人或 Agent 发起提及、主人 Web 审批后执行的完整真实链路；
- Linux 平台与无 `uv` 环境的实际安装验证。

已知限制：
- 本工具专为 Antigravity CLI (`agy`) 编写（凭证读取 `~/.gemini/config/mcp_config.json`，执行依赖 `agy -p --output-format json --conversation --settings`），不能直接用于其他 Agent 客户端；
- 本地 `inbox.jsonl` 不自动裁剪；
- 不保证 exactly-once（中断残留的 `running` 事件重启后不自动重发，需人工 `agy-knot trigger <event_id>` 确认）。
