# pi-ssh-workspace

把 pi 的基础工具（read / write / edit / bash / grep / find / ls）整体路由到远端 SSH workspace，本地使用体验不变，后台子代理自动跟随。基于官方 `examples/extensions/ssh.ts` 的 operations 注入模式，不依赖任何 npm 包，只用系统 `ssh`，只支持密钥 / agent 认证。

## 安装

```bash
ln -s /Users/leen/dotfiles/pi/extensions/pi-ssh-workspace/index.ts ~/.pi/agent/extensions/pi-ssh-workspace/index.ts
# 同样链接 config.ts 和 remote.ts（或整个目录逐文件链接，参照 pi-proxy-router）
```

## 配置

`~/.pi/agent/ssh-workspace.json`：

```json
{
  "defaultAlias": "dev",
  "aliases": {
    "dev": { "host": "devbox", "path": "/srv/project", "description": "开发机" },
    "gpu": { "host": "user@gpu-box", "port": 2222, "path": "/data/train" }
  }
}
```

- `host` 必填，直接传给 ssh，支持 `~/.ssh/config` 别名和 `user@host`
- `port` 可选，有则 `-p`
- `path` 可选，远端工作根目录；省略时连接后用远端 `pwd` 解析
- `description` 可选，`/ssh` 列表里显示

## 命令

| 命令 | 功能 |
| --- | --- |
| `/ssh` | 列出别名供选择（标记当前） |
| `/ssh <alias>` | 进入或直接切换远端 |
| `/ssh exit` | 回到本地 |
| `/ssh status` | 显示别名、host、远端根目录 |
| `/ssh reload` | 重读配置文件 |
| `/ssh forget` | 断开并清除环境变量 |
| `pi --ssh <alias>` | 启动即进入远端 |

## 行为

- 未进入远端时：所有工具透传给 pi 内置本地实现，等于没有这个扩展。
- 进入远端后：7 个工具走远端；`powershell` 在远端（Unix）返回明确错误。
- 路径映射：启动目录（anchor）映射到远端根目录；anchor 外的绝对路径原样透传（可直接读 `/etc/...`）。
- `!` / `!!` 命令走远端。
- 系统提示的 `Current working directory` 行被改写为远端路径，模型始终知道自己在远端；正则未匹配时在末尾追加说明兜底。扩展不会注入任何会话消息。
- 状态栏常驻 **绿色** `SSH: connected`；进入/切换/退出都有 notify 提醒；切换失败保持原状态。
- 远端目标写进**会话名**（`host:/remote/root`，如 `aliyun:/webprojects/gzstv/GZSTVSite`），pi / zentui 会把它显示在输入框顶部那一行（zentui 的 minimalist editor 里就是计时器旁边那串绿字）。用户用 `/name` 自己命名的会话不会被覆盖，退出时恢复。
  - zentui 会重新给扩展状态上色，所以 `~/.pi/agent/zentui.json` 里已设 `components.footer.styles.starship.extensionStatuses.colorModes["ssh-workspace"] = "original"` 保留扩展自带的绿色；位置用同层 `placements["ssh-workspace"]`（`left`/`middle`/`right`/`off`）调整，默认 `right`。
- 连接复用：ControlMaster/ControlPersist（10 分钟），避免每次工具调用重新握手。
- 写文件：原始字节走 stdin 管道（`cat > <path>`），不 base64、不经命令行参数；shell 参数单引号转义。
- `defaultAlias`（可选）：`/ssh` 列表里标记为默认并排在首位。

## 子代理

- **后台子代理（async: true，默认）自动跟随远端**：runner 进程继承 `PI_SSH_WORKSPACE` / `PI_SSH_LOCAL_ANCHOR` 环境变量并加载本扩展。
- 前台子代理（`async: false`）在远端模式下被拦截并提示改用后台——机制上前台子代理不加载环境扩展，会在本地文件系统运行。
- `worktree: true` / `isolation: "worktree"` 在远端模式下被拦截（worktree 是本地 git 操作）。
- 状态是进程级的：不写 session 分支、不注入消息，避免旧扩展与子代理的冲突问题。
- **连接失败的封锁语义**：启动时（`--ssh` 或环境变量派生）连接失败会进入封锁状态——所有工具调用直接报错，绝不静默回退到本地文件系统（后台子代理尤其危险）。页脚显示 `● SSH <alias> 连接失败`，修复后 `/ssh <alias>` 重试或 `/ssh exit` 清除。

## 本地访问工具（local_bash / local_read）

进入远端后，`read`/`bash` 等全部作用于远端，本地不可达。若需**偶尔**操作本地，扩展提供两个显式工具：

| 工具 | 作用 |
| --- | --- |
| `local_bash` | 在本地机器执行命令 |
| `local_read` | 读本地文件 |

- 仅在 SSH workspace **连接成功后**出现在可用工具列表里；`/ssh exit` 后移除；连接失败（封锁状态）不激活。
- 两者完全不受远端影响——即使远端断连，`local_bash`/`local_read` 仍操作本地。
- 子代理默认拿不到这两个工具（没有 agent 声明它们）；如需给某个子代理本地访问能力，在该 agent 的 `tools:` 里显式声明。
- 只在**交互式会话**里激活（`ctx.hasUI` 为真）：`pi -p` / `--mode json|rpc` 以及后台子代理的 runner 进程都不会激活它们。
- 连接失败的封锁状态下两者不可用——不会静默回落本地。

## 已知限制

- 取消/超时只杀本地 ssh 进程，远端进程可能残留。
- `workflowScript` / `workflow` 内 `runs.run(...)` 的每步参数（如 `worktree`、`cwd`）拦截不到。`subagent` 的 `cwd` 必须是**本地**路径（远端路径会被自动改写回本地 anchor）；workflow 内部给步骤设 cwd 时请用本地 anchor。
- 子代理的 `cwd` 由 pi-subagents 在本地校验（`fs.statSync`），远端路径会启动失败——扩展已在 `subagent` 调用时自动把远端路径归一化为本地对应路径。
- 远端 `grep` 需要远端安装 ripgrep (`rg`)。输出格式对齐内置（相对路径 `路径:行号:内容`，context 用 `-` 分隔），但 limit 是按总输出行数近似截断（内置按匹配数），与内置有差异。
- 远端 `find` 优先用 `rg --files`，其次 `fd --glob`，都没有时用 `find -path`（建议远端装 ripgrep，兼顾 grep）。
- `read` 会下载完整远端文件后再截断；特别大的文件建议用 bash `sed -n` 取片段。
- 不支持 Windows 远端、密码认证、`/ssh cd`、后台任务 PTY、`@` 路径补全。
