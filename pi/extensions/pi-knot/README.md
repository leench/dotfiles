# pi-knot

把一个 Pi 会话接到一个**明确的 Knot agent session** 的 WebSocket 通知：单条连接、只写入本地收件箱；可选地把“主人直接 @ 或已审批”的 `mention.execute` 自动送交同一个 Pi 会话。

## 做什么 / 不做什么

- 一个 Pi 会话只对应一个 Knot `agent_session_id`；重连、重启、`/reload`、`/resume` 都复用同一个会话，**不会新建 Knot 会话**。
- 一条 WS 接收该会话**已加入的所有 Room** 的事件，按 `room_id` 区分；不 join Room、不借别人的成员权限。
- 默认（`autoExecuteMentions: false`）事件只进本地收件箱，**不会自动注入模型上下文，也不会自动回复、自动执行或自动审批**；开启后也只有结构化 `mention.execute` 会被自动送交当前会话，详见「自动处理」。
- 不重做 MCP：正文仍然由模型通过已有的 Knot MCP 按需读取。
- 交给模型的入口有两个：显式 `/knot read <event_id>`，或开启自动处理后的结构化 `mention.execute`（同一 Pi 会话内可见的 followUp 消息）。

`/knot read` 只表示**请求阅读**：它把该事件的定位信息作为当前 Pi 会话里可见的自定义消息（`display: true`）交给模型，由模型按需用已配置的 Knot MCP 取正文。read 不是执行授权：不自动回复、不自动执行、不调用审批或发送接口。用户之后明确要求执行时，也仍然走这个会话正常的、可见的工具流程与审批，本插件不启动子 agent，也不在后台静默执行任何 Knot 任务。

`/knot read` 只表示**请求阅读**：它把该事件的定位信息作为当前 Pi 会话里可见的自定义消息（`display: true`）交给模型，由模型按需用已配置的 Knot MCP 取正文。read 不是执行授权：不自动回复、不自动执行、不调用审批或发送接口。用户之后明确要求执行时，也仍然走这个会话正常的、可见的工具流程与审批，本插件不启动子 agent，也不在后台静默执行任何 Knot 任务。

## 依赖与部署

- Pi 1.4.x（使用 `ExtensionAPI`），Node ≥ 22.19。
- 运行时依赖只有 `ws`：Knot 要求 `Authorization: Bearer` 请求头，Node 内置 `WebSocket` 无法设置自定义头。
- Pi 宿主包写在 `peerDependencies`（`*`，optional），不作为 `dependencies` 捆绑；运行时由 Pi 自己的虚拟模块提供。
- `devDependencies`（`typescript`、`@types/node`、`@types/ws`）只用于可复现的类型检查；部署时可以 `npm ci --omit=dev` 跳过它们。

源码在本仓库 `pi/extensions/pi-knot/`，由 `pi/sync.sh` **逐文件**软链到 `~/.pi/agent/extensions/pi-knot/`。不要改成整目录软链：`sync.sh` 在重建链接时会 `rm -rf` 目标，目录软链可能删到 dotfiles 里的源文件。

常规方式（`sync.sh --update` 会预检并修复**所有**受管文件链接、合并 `defaults/common.json` 里显式列出的 settings 字段，并对每个带 lockfile 的扩展执行 `npm ci`；`PI_SYNC_SKIP_PACKAGES=1` 只是跳过 `packages` 字段合并和 `pi update --extensions`，并不等于“只改本插件”）：

```bash
cd ~/dotfiles
./install.sh pi                                  # 完整同步
# 或
PI_SYNC_SKIP_PACKAGES=1 ./pi/sync.sh --update     # 仍会处理其他受管文件与 settings 公共字段
```

只部署本插件（不写 settings、不碰其他扩展）。脚本**先预检全部目标**，任何目标已存在但不是指向本插件的软链就整体中止；已有的 `node_modules` 不会被覆盖或删除：

```bash
set -euo pipefail
SRC="$HOME/dotfiles/pi/extensions/pi-knot"
DST="$HOME/.pi/agent/extensions/pi-knot"
mkdir -p "$DST"

# 1) 预检：不修改任何文件
problem=0
while IFS= read -r -d '' file; do
  rel="${file#./}"
  target="$DST/$rel"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ ! -L "$target" ] || [ "$(readlink "$target")" != "$SRC/$rel" ]; then
      printf '冲突：%s 已存在，且不是指向 %s/%s 的软链\n' "$target" "$SRC" "$rel" >&2
      problem=1
    fi
  fi
done < <(cd "$SRC" && find . -type f -not -path './node_modules/*' -print0)
[ "$problem" -eq 0 ] || { echo "预检未通过，未做任何修改" >&2; exit 1; }

# 2) 只补缺失的链接，不覆盖已正确的链接
while IFS= read -r -d '' file; do
  rel="${file#./}"
  target="$DST/$rel"
  [ -L "$target" ] && continue
  mkdir -p "$(dirname "$target")"
  ln -s "$SRC/$rel" "$target"
done < <(cd "$SRC" && find . -type f -not -path './node_modules/*' -print0)

# 3) 依赖只在目标缺失时安装（只要运行时可加 --omit=dev）
if [ -e "$DST/node_modules" ]; then
  echo "已存在 $DST/node_modules，跳过安装"
else
  (cd "$DST" && npm ci --ignore-scripts --no-audit --no-fund)
fi

# 4) 源侧 bridge：不删除、不覆盖已有目录
if [ -L "$SRC/node_modules" ]; then
  [ "$(readlink "$SRC/node_modules")" = "$DST/node_modules" ] ||
    { echo "bridge 指向异常，请人工检查 $SRC/node_modules" >&2; exit 1; }
elif [ -e "$SRC/node_modules" ]; then
  echo "源目录已有 node_modules（非软链），保持原样"
else
  ln -s "$DST/node_modules" "$SRC/node_modules"
fi
```

装好后在 Pi 里 `/reload`（或重启 Pi）即可加载。

## 配置

配置文件：`${PI_CODING_AGENT_DIR:-~/.pi/agent}/knot.json`。仓库里只有无凭证的 `knot.example.json`，**不会**被自动复制（同步脚本不写本机配置），需要自己复制后修改：

```bash
cp ~/.pi/agent/extensions/pi-knot/knot.example.json ~/.pi/agent/knot.json
chmod 600 ~/.pi/agent/knot.json
```

```json
{
  "restUrl": "https://knot.example.com",
  "wsUrl": "wss://knot.example.com/ws/agent-sessions/5",
  "agentSessionId": 5,
  "allowLocalhost": false
}
```

| 字段 | 说明 |
| --- | --- |
| `restUrl` | Knot 基址，必须 `https`（本地开发见 `allowLocalhost`）；不允许用户名密码、查询串或片段 |
| `wsUrl` | 可选。默认由 `restUrl` + `agentSessionId` 推导；显式写出时必须与 REST 同源，路径严格等于 `/ws/agent-sessions/<agentSessionId>` |
| `agentSessionId` | 已存在的 Knot Agent 会话 ID（正整数），重连不会创建新会话 |
| `allowLocalhost` | 仅本地开发：显式允许 `http://` / `ws://` 的 `localhost`、`127.0.0.1`、`[::1]` |
| `autoExecuteMentions` | 可选，默认 `false`。开启后只把“主人直接 @ 或已审批”产生的结构化 `mention.execute` 自动送交当前会话，详见下文 |

环境变量覆盖（非空 `KNOT_AGENT_TOKEN` 优先；未设置时回落到用户级 `mcp.json`，见下节）：

```bash
export KNOT_REST_URL="https://knot.example.com"
export KNOT_WS_URL="wss://knot.example.com/ws/agent-sessions/5"
export KNOT_AGENT_SESSION_ID="5"
export KNOT_AGENT_TOKEN="<agent token>"
```

### 凭证来源（优先级）

1. **非空 `KNOT_AGENT_TOKEN`** —— 已设置但格式非法时**直接失败**，不会偷偷回退到 `mcp.json`。
2. **用户级 `<agentDir>/mcp.json` 的 `mcpServers.knot`** —— 复用该 MCP 条目 `headers` 里的 `Authorization: Bearer <token>`（头名大小写不敏感）。

复用 MCP 凭证时的限制（不满足即失败，不回退、不猜）：

- 只读**用户级** `<agentDir>/mcp.json`（默认 `~/.pi/agent/mcp.json`）；项目级 `.pi/mcp.json`、`mcp-auth.json`（OAuth）一律不读。
- 只认服务名 `knot`；其它 MCP 服务的凭证不会被借用。
- 条目必须是 HTTP 形式（有 `url`、无 `command`、`type` 为 `http`/`streamable-http` 或省略），且 `enabled !== false`。
- `url` 必须与 `restUrl` **同源**（协议 + 主机 + 端口），不能带用户名/密码；因此同样受 HTTPS / localhost 规则约束。
- `Authorization` 支持静态 `Bearer xxx` 与纯环境替换 `Bearer ${VAR}`；未解析的变量会报出变量名（不含值）。`!command` 形式**不执行**，直接拒绝。
- 只接受 Bearer；`Basic`、裸 token、OAuth-only 条目一律拒绝。
- 缺 `mcp.json` / `knot` 条目 / 头时给出明确原因，说明“设置 KNOT_AGENT_TOKEN 或配置 mcpServers.knot”。

`/knot status` 会显示**来源标签**（环境变量 / 用户级 mcp.json），但不显示 Token。修改 MCP 凭证后：先 `/knot disconnect`，再 `/knot connect`（`connect` 会重新读取配置与凭证）。

安全规则：

- Token 只保存在内存；`knot.json` 里出现 `token`/`authorization`/`bearer` 一类字段会被忽略并提示（提示里的键名同样脱敏）。
- 落盘/展示前只保留协议白名单字段：`sender.kind` 仅接受 `human`/`agent_session`/`agent`；`summary` 与发送者名字去掉控制字符并抹掉凭证；`message_version` 这类必须保持语义的字段一旦命中凭证就整条拒收（不推进游标）。UI 通知与状态栏在出口处再统一脱敏一次。
- Token（无论来自环境变量还是 `mcp.json`）只进入 `Authorization` 请求头，不写进 URL、状态文件、日志、`knot.json` 或会话记录；服务端回显的文本写盘前也会把 Token 抹成 `***`。
- REST 与 WS 都不跟随重定向（避免把 `Authorization` 转发到别处），握手阶段收到 3xx/401/403/404 直接停止。
- 缺少配置时保持未连接，只在状态栏与 `/knot status` 说明原因，不阻塞 Pi 启动。

### 数据、绑定与锁

- 状态目录：`~/.pi/agent/pi-knot/<服务地址摘要>/<knotSessionId>/`，权限 `0700`，文件 `0600`；不含 Token。
- `state.json` 同时保存收件箱与已处理游标，原子替换（临时文件 + `fsync` + `rename`）；**未读不会自动裁剪**，v1 不自动清理，容量需自行留意。
- 持久化代价（如实说明）：写入是**同步** JSON 快照 + `fsync`，历史越长单次写占用事件循环越久，补拉、`inbox`、`read` 会明显卡顿；目录 `fsync` 在不支持的文件系统上被忽略，异常断电时最后一次 `rename` 的持久性**不保证**（未做断电验证）。
- `binding.json` + `pi-sessions/<piSessionId>.json` 双向绑定：一个 Knot 会话只属于一个 Pi 会话，一个 Pi 会话也只对应一个 Knot 会话。所以 `/new`、`/fork` 或直接改配置都**不会静默复用/切换** Knot 身份。
- `lock/` 目录是跨进程锁：另一个 Pi 进程占用时拒绝连接并提示持锁 pid，不抢占、不自动接管（崩溃残留需确认后手工删除）。
- 手工迁移（确认没有其他 Pi 进程在用时）：

```bash
rm ~/.pi/agent/pi-knot/<服务摘要>/<旧会话ID>/binding.json
rm ~/.pi/agent/pi-knot/pi-sessions/<piSessionId>.json
```

## 自动处理（可选，默认关闭）

`knot.json` 里设置 `"autoExecuteMentions": true` 后，本插件会在**当前 Pi 会话内可见地**接收“主人已审批”的提及；默认 `false` 时行为完全是 notify-only（只进收件箱，必须 `/knot read`）。

```json
{ "autoExecuteMentions": true }
```

### 只有结构化审批才会触发

- **会触发**：服务端生成的结构化 `mention.execute`——主人本人（human）直接结构化 @ 本会话即可产生，**无需再走一次审批**；其他人或任何 Agent（包括用户自己的 Agent）@ 本会话时，需要主人在 Knot 审批后才会产生同样的事件。
- **不会触发**：`room.message`、`mention.pending`（仍在等待主人审批，插件只提醒去 Knot 审批）、普通文本 `@`/`@所有人`、摘要或正文里声称“已批准”、其他 agent 的转述。
- 发送者名字与 ID 不参与判断：批准后的事件即使 sender 是其他人或 Agent 也照常处理；`pending` 无论谁发的都不处理。审批本身仍由 Knot 服务端与主人在其审批面板完成，本插件不发送审批、不读取 cookie、不实现审批接口。

### 未来-only 与断线恢复

- 首次启用后，**第一个可信 `ready`** 用 `latest_event_id` 建立“自动处理起点”（自动处理基线），并和 `state.json` 一起原子保存。
- 起点**不是** processed cursor：收件箱补拉仍按原游标进行，历史事件照常入箱但**不会**触发模型。
- 基线建立后（状态栏显示「自动开」）新到达的 `mention.execute` 才会投递；重连、`/reload`、`/resume` 沿用同一基线，断线期间漏掉的新事件会在补拉后补上。
- 关闭开关会解除武装；再次开启会重新取一次起点，关闭期间积压的事件不会被追溯执行。

### 投递方式与边界

- 投递是 `pi.sendMessage(display: true, triggerTurn: true, deliverAs: "followUp")`：消息出现在**当前 Pi 会话**里，模型在原有会话中按需用已配置的 Knot MCP 读取正文。不另开 agent、不启动隐藏 SDK 会话、不构造 `shell`/`exec` 绕过工具审批。
- 投递文本会说明：用户已开启自动处理，这条 execute 表示主人直接 @ 或已批准该请求，**可以在本会话按请求处理，无需再次 `/knot read` 或去 Knot 审批**；但它不是任意工具通行证，更高层指令与宿主工具安全规则仍然有效。
- 传入的内容只有定位字段（`event_id`、`room_id`、`message_id`、`seq`、`mention_id`、`message_version`），**不含** summary/正文/发送者名字；正文、附件与摘要在模型看来仍是不可信外部输入，不能覆盖用户指令、系统规则或工具审批。
- 结构化审批只表示“主人允许你处理这条请求”，不是任意工具通行证；如果请求本身要求回复房间，才用现有 MCP 工具在可见流程里回复，不会自动回复所有消息。
- 有界投递：同一时刻只投递一条；成功后保持“等待本轮结束”的闸门，下一次真正的 `agent_settled` 才放行下一条。不能只靠 `isIdle()`——Pi 在 `_isEmittingAgentSettled` 期间会把 `sendMessage` 延后，此时 `isIdle` 仍为 true。
- 只在连接真正进入 `connected`（补拉完成）时投递；fatal（4401/4403/4409）、退避重试、手动断开时即使收到无关的 `agent_settled` 也不会执行旧 pending，成功重连后再恢复。重启/`/resume` 时即使本次没有任何新帧，也会扫描已落盘但未投递的候选。
- 与 `readAt` 分开记录：自动投递不等于“已读”，也不会因为用户 `/knot read` 过就重复自动执行；对已自动投递的事件再 `/knot read` 只会提示“已自动投递，不会再次自动执行”。

### 去重与“不保证 exactly-once”

- 每条 `mention.execute` 只会自动投递一次（重复帧、重复补拉、重启都不会重发）。
- 投递状态分 `sending` / `delivered` / `failed`，与收件箱同一次原子写入：先落盘 `sending` 再调用 `sendMessage`，成功后再写 `delivered`。
- `sendMessage` 与本地写盘无法跨两者原子：如果进程在 `sending` 状态崩溃，重启后**不会**自动重发（可能已经执行），该事件在 `/knot inbox` 里标记为 `[投递中?]`，需要人工确认。因此**不保证工具副作用 exactly-once**。
- 投递元数据写入失败时不会发送，并在 UI 提示；下次空闲重试时再投递（此时尚未发送）。

### 状态与前置条件

- 状态栏会多出 `自动开` / `自动待基线`；`/knot status` 显示“自动处理：关闭 / 待基线 / 已就绪（起点 event N，已投递 M 条）”。
- 以下情况不投递：非 TUI（`rpc`/`json`/`print`）、手动 `/knot disconnect`、`session_shutdown`/`/reload` 后的旧 runtime、本地锁被占用、Knot 会话与 Pi 会话绑定冲突、连接未处于 `connected`（fatal/重试中）、以及尚未建立基线。
- 共享快照只在“拿到独占锁 + 正反绑定都匹配”之后才会写：读配置、打开收件箱、`inbox`/`read`、绑定冲突或非 TUI 启动都不会改动别人的 `state.json`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/knot status` | 连接状态、Knot 会话、凭证来源、游标、未读数、最近错误、配置与绑定路径 |
| `/knot connect` | 显式连接（已连接则不动） |
| `/knot disconnect` | 断开并释放本地锁；绑定与未读保留 |
| `/knot inbox` | 选择框列出事件类型、Room、楼层、发送者、摘要；每页 50 条，可上一页/下一页；选中只显示详情，**不**交给模型 |
| `/knot read <event_id>` | 把该事件的定位信息作为可见自定义消息交给当前会话；不推进游标 |

状态栏固定为一行：`knot · 已连接 · 会话 5 · 未读 3`。

限制（避免误用）：

- `connect` / `inbox` / `read` 只在 TUI 模式可用；`rpc` / `json` / `print` 下这些命令不会建连接、不弹选择框、不触发模型（`status` / `disconnect` 静默执行）。
- `inbox` / `read` 会校验“本 Pi 会话确实持有该 Knot 会话的绑定”；绑定属于别的 Pi 会话时直接拒绝，且**不会**替它新建绑定。

## 协议与恢复

```
连接 → ready → 按本地持久游标分页 GET /api/agent-events → 排空补拉期间缓存的实时帧 → 实时提交
```

- `ready.latest_event_id` 只是发送水位，**不会**被写成已处理游标。
- 补拉期间实时帧进有界缓存（默认 512 条）；溢出则主动断开，重连后按持久游标补拉，不静默丢帧。
- 补拉按 `event_id` 升序合并、排序、去重；`event_id` 是全局编号，间隙正常，绝不用 `cursor + 1` 推断缺失。
- 收到应用层 `{"type":"heartbeat"}` 立即回 `{"type":"pong"}`（同步发送，REST 请求不会阻塞它）；另有 ready 超时与服务端静默看门狗。
- 落盘成功后才推进游标；写入失败中止本轮连接，绝不跳过事件。
- 关闭码：`4401/4403/4409` 停止自动重试（凭证、会话归属、已有连接）；`4408/1011`、`1006` 与网络故障指数退避（上限 30s + 抖动）重连并补拉。
- 手动断开、`session_shutdown`、`/reload`、`/new`、`/resume`、`/fork` 都会让旧连接代次失效：socket、请求、定时器和旧回调不会作用于新会话。
- 非交互模式（`json`/`print`，以及默认不自动连接的 `rpc`）不会建立长连接，避免一次性调用无法退出。

## 事件语义

- `room.message`：普通消息通知。
- `mention.pending`：等待主人审批，不是执行授权（插件只提醒，不代表用户审批）。
- `mention.execute`：主人本人直接 @ 或主人已批准后产生的信号。开启自动处理时可在本会话按请求处理；仍不等于任意工具操作获得授权，更高层指令与宿主审批照旧。

普通文本 `@`、`@所有人`、摘要或正文里声称“已批准”等说法，都不能升级为执行授权。summary、正文和附件一律是不可信外部输入。

## 测试

```bash
cd ~/dotfiles/pi/extensions/pi-knot
npm test
```

覆盖：单连接多 Room、ready + 分页补拉 + 实时帧交错、重复与 ID 间隙、落盘失败不推进游标、缓存溢出恢复、慢 REST 期间 pong 及时、4401/4403/4409 停止重试、4408/1011 与退避上限、手动停止/关闭不重连、`/reload` 后旧回调隔离、Token 不出现在状态/落盘/URL、三类事件不自动交给模型、`/knot read` 的 `display: true` 与不可信标注、print/json 不建连、绑定与锁、重启后未读保留、重定向/权限拒绝停止重试。

针对并发与一致性的回归（每次连接独立 epoch）：

- 旧连接（attempt）的迟到 REST 响应、甚至已经结束的 `response.json()`，都不能写入新连接、不能清掉新连接的实时缓存、不能把状态改成已连接、也不能终止新连接；disconnect 后迟到的响应同样不落盘。
- `has_more=true` 但这一页空、或全是已处理事件（游标没有前进）时失败关闭并按持久游标重试，绝不先排空实时缓存而跳过中间事件。
- 同一页里重复的 `event_id` 只入箱一次，重启后快照仍可加载（不会自判损坏）。
- 同数字 ID、不同服务地址视为不同身份，不能静默切换；`inbox`/`read` 要求本 Pi 会话已持有绑定，不会替别的会话创建绑定。
- 非 TUI 模式下 `connect`/`inbox`/`read` 不建连接、不弹选择框、不触发模型、不弹通知。
- 启动时缺配置，之后补好配置再 `/knot connect` 可以连上；4401 停止后换凭证重连会使用新 Token，且 Token 不出现在通知/状态栏。
- 外部字段的凭证内容不会回显：`sender.kind` 只接受协议枚举，`summary`/`sender.name` 脱敏，`message_version` 命中凭证时拒绝整条事件（不推进游标），配置里的未知键名也脱敏。
- disconnect 清掉待发的批量通知；选择框等待期间 shutdown，旧 runtime 不再弹通知。
- `error` 事件的 500ms 兜底定时器挂在 attempt 上：同一 attempt 只建一次，`stop`/`shutdown` 统一清除，不会在退出后回调或触发重连。
- 收件箱按 50 条分页，可翻到超过 50 条的更早未读事件；取消即结束，翻页与查看详情都不会标记已读或触发模型。
- 凭证来源：环境变量优先、mcp.json 回落、环境变量非法时不回退、头名大小写、`${VAR}` 替换、未定义变量、`!command` 拒绝、同源拒绝、禁用/stdio/非 Bearer/OAuth/缺条目拒绝、坏 JSON 不回显、项目级不提供凭证、复用的 Token 不出现在 UI 与落盘。
- 跨会话写入保护：已 armed 状态下第二个 Pi 会话、锁被占用、非 TUI 启动前后 `state.json` 逐字节不变；owner 以关闭状态连接才 disarm 且不丢事件，重新开启会重建基线。
- 自动处理：默认关闭时不建基线、不投递；开启后只投递结构化 `mention.execute`（pending/普通消息/文本 @/“已批准”摘要/Agent sender 的 pending 都不投递）；批准事件即使 sender 是 Agent 也只投递一次；首次启用时 ready 水位之前的历史 execute 不执行且基线不推进游标；断线重连后基线之后的新 execute 会自动补投；重复帧与重复补拉只投递一次；批量到达时一次只投一条并在 `agent_settled` 后继续；宿主延后 settled（`isIdle` 仍为 true）时也只能一条一条来；重启后有未投递候选（即使本次无新帧）会自动投递；fatal/重试/手动断开时 settled 不投递、重连后恢复；收件箱写失败与投递元数据写失败都不发送；shutdown 后旧回调不投递；非 TUI 与绑定冲突不投递；显式 read 已投递事件只提示；`sending` 残留不自动重发。

测试全部使用 `127.0.0.1` 上的假 HTTP/WS 服务与临时目录，不连正式服务、不读取正文、不发送消息。

类型检查（使用**当前已安装 Pi 的真实类型声明**，不在插件里捆绑另一份 Pi）：

```bash
cd ~/.pi/agent/extensions/pi-knot
npm ci                 # 安装 ws + typescript/@types
npm run typecheck      # scripts/typecheck.mjs
```

`scripts/typecheck.mjs` 按顺序查找宿主类型入口，并把路径写进 `node_modules/` 下的**临时** tsconfig（受管 `tsconfig.json` 里没有机器路径）：

1. `PI_KNOT_HOST_PACKAGE` 显式指定的 `@earendil-works/pi-coding-agent` 目录；
2. 本地模块解析（把宿主装成 dev 依赖时）；
3. Pi 自己的托管安装布局：`<agentDir>/install/current-version` → `releases/<版本>/node_modules/@earendil-works/pi-coding-agent`；
4. 从 `pi` 可执行文件真实路径向上查找。

脚本会打印实际使用的宿主版本与来源；类型检查结束即删除临时配置。

## 已验证 / 未验证

已验证（本仓库自动化结果）：

- 114 个单元/集成测试通过（本地假服务）；
- `npm run typecheck` 通过：tsc 5.9.3 + 已安装的 `@earendil-works/pi-coding-agent@1.4.0` 真实类型声明（来源：Pi 托管安装）；
- 模块能被 Node 直接 import，并用假 `ExtensionAPI` 完成 `session_start` / `/knot read` / `session_shutdown` 流程。

已验证（用户授权的真实 Pi / Knot 联调）：

- 主人以人类身份结构化 @ 当前会话后，事件自动投递到原 Pi 会话，无需手动 `/knot read` 或另行 Knot 审批；
- 原 Pi 会话通过真实 Knot MCP 读取对应正文，按测试请求在聊天室回复 `hi`；
- 读取、工具调用及结果在原终端可见，用户确认本次测试成功。

未验证（不能由上述单次成功推断）：

- 真实服务上的长时间心跳、跨网络抖动、断线恢复及全部 440x 关闭码；
- 其他人或 Agent 发起提及、主人审批后执行的完整真实链路（目前只有本地模拟覆盖）；
- 真实 `agent_settled` 的批量串行投递边界、跨进程重启恢复与 4409 客户端冲突；
- 异常断电下最后一次快照的持久性。

本次真实联调只验证上述主人直接 @ → 原会话自动处理 → MCP 回复链路，不代表所有生产场景都已验证。

已知限制：未读不自动裁剪（磁盘会随时间增长）；崩溃残留的本地锁需要手工删除；`/knot inbox` 每页 50 条（可翻页，不支持搜索/过滤）；不支持多 Pi 会话共用同一个 Knot 会话；自动投递不保证 exactly-once（`sending` 残留需人工确认，不会自动重发）。

本仓库没有配置 TypeScript LSP server，编辑器内诊断不可用；类型结果以上面的 `npm run typecheck` 为准。
