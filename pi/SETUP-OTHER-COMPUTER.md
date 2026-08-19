# 在其他电脑部署 Pi 配置

这份文档是给 coding agent 的执行手册。目标是把本仓库中的稳定 Pi 配置接入当前电脑，同时保留当前电脑的运行时状态和认证信息。

## 绝对规则

- 先读完整份文档，再执行命令。
- 不复制、不提交、不删除以下内容：
  - `~/.pi/agent/auth.json`
  - `~/.pi/agent/sessions/`
  - `~/.pi/agent/run-history.jsonl`
  - `~/.pi/agent/npm/node_modules/`
  - `~/.agents` 中未纳入本仓库的运行时数据
- 不直接覆盖整个 `~/.pi/agent/settings.json`。
- 不使用 `rm -rf`、`stow -D` 或手动删除本机 Pi 配置来“解决”冲突。
- 不在发现本机配置冲突时自动把文件复制进 dotfiles，也不自动覆盖本机文件。
- 不自动 commit、push 或丢弃当前 Git 工作树中的其他修改。
- 如果任一步骤出现冲突或不确定，停止并报告具体路径，不要强行继续。

## 1. 确认仓库和前置依赖

默认仓库路径为 `~/dotfiles`。先确认当前目录是目标仓库：

```bash
DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
test -d "$DOTFILES_DIR/pi"
git -C "$DOTFILES_DIR" rev-parse --show-toplevel
```

确认以下命令存在：

```bash
command -v git
command -v stow
command -v jq
command -v npm
command -v pi
```

初始化 Pi 自研 extension 的 submodule：

```bash
cd "$DOTFILES_DIR"
git submodule update --init --recursive
```

如果缺少命令，先向用户报告缺少的依赖；不要自行删除或替换已有 Pi 配置。

确认 Pi 没有正在执行迁移相关操作。若 Pi 正在运行，不要强行终止；先请用户退出 Pi，再继续。

## 2. 备份当前电脑

无论是全新电脑还是已有 Pi，都先备份存在的运行目录：

```bash
backup_root="$HOME/pi-backups"
backup_dir="$backup_root/pi-before-dotfiles-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

paths=()
[[ -e "$HOME/.pi" ]] && paths+=(.pi)
[[ -e "$HOME/.agents" ]] && paths+=(.agents)

if ((${#paths[@]})); then
    tar --zstd -cf "$backup_dir/config.tar.zst" -C "$HOME" "${paths[@]}"
    sha256sum "$backup_dir/config.tar.zst" > "$backup_dir/SHA256SUMS"
    sha256sum -c "$backup_dir/SHA256SUMS"
else
    printf '%s\n' '当前没有 ~/.pi 或 ~/.agents，跳过归档。'
fi
```

校验失败时立即停止。

## 3. 执行安全迁移

```bash
cd "$DOTFILES_DIR"
./install.sh pi
```

`pi/sync.sh` 会先预检以下内容：

- `~/.pi/agent/AGENTS.md`
- `~/.pi/agent/subagents.json`
- `~/.pi/agent/agents/`
- `~/.pi/agent/prompts/`
- `~/.agents/skills/`
- 受管的 Pi extensions
- remote skill symlink

### 预检失败时

如果看到以下类型的错误：

```text
本机文件未纳入 dotfiles
本机文件与 dotfiles 不一致
本机 symlink 指向其他位置
预检发现本机配置与 dotfiles 有差异
```

立即停止。不要重试、不要手动删除目标、不要使用强制覆盖选项。

把错误路径和备份路径报告给用户。用户确认后，只有两种安全处理方式：

1. 将需要保留的内容人工整理到 `pi/` 源目录并提交到 dotfiles；或
2. 用户确认不需要后，人工移除该本机差异，再重新运行 `./install.sh pi`。

当前同步脚本不会自动采用本机额外文件，也不会自动覆盖不同内容。

### package 或网络失败时

如果稳定配置已经建立，但 package 安装因为网络或 npm 失败：

- 不要回滚整个 `~/.pi`。
- 保留脚本生成的 `~/pi-backups/pi-sync-*` 局部备份。
- 报告错误后，在网络恢复时重新执行：

```bash
cd "$DOTFILES_DIR"
./pi/sync.sh --update
```

## 4. 验证部署

```bash
cd "$DOTFILES_DIR"
./pi/sync.sh --check
pi --version
pi list
```

确认以下路径是 symlink，并指向当前 dotfiles：

```bash
readlink -f "$HOME/.pi/agent/subagents.json"
readlink -f "$HOME/.pi/agent/agents"
readlink -f "$HOME/.pi/agent/prompts"
readlink -f "$HOME/.agents/skills"
```

确认认证文件仍由本机管理：

```bash
stat -c '%a %F %n' "$HOME/.pi/agent/settings.json" "$HOME/.pi/agent/auth.json"
```

启动 Pi 后，在本机单独执行：

```text
/login
```

不要从其他电脑复制 `auth.json`。

## 5. 主机专属配置

主机专属配置属于本机状态，不放入 dotfiles 仓库；但全机器共用的 Pi subagent 策略由 `pi/agents/`、
`pi/extensions/subagent/config.json` 和 `pi/defaults/common.json` 管理。首次创建或显式应用
defaults 时，脚本会读取：

- 所有电脑使用仓库中的 `pi/defaults/common.json`
- 如果存在，则额外使用 `~/.pi/agent/host-defaults/<hostname>.json`
- 已存在的 `settings.json` 不会被整体覆盖
- `defaults/common.json` 中显式存在的字段会在日常 `sync.sh --update` 时同步覆盖
- settings 中仅存在于本机的字段、package 和 extension 会保留
- `agents/` 和 `extensions/subagent/config.json` 会建立 symlink 同步
- `defaults/common.json` 中的 `subagents.disableBuiltins` 会同步到每台主机的 `settings.json`
- `packages.txt` 会确保所有主机使用同一版本的 `npm:pi-subagents`

例如在本机创建配置：

```bash
mkdir -p "$HOME/.pi/agent/host-defaults"
${EDITOR:-vi} "$HOME/.pi/agent/host-defaults/$(hostname -s).json"
```

不要把另一台电脑的 host 配置直接套用过来；没有本机文件时，只使用公共 defaults。

## 6. 后续更新

如果当前电脑已经部署了 dotfiles，后续使用：

```bash
cd "$DOTFILES_DIR"
git pull --rebase
git submodule update --init --recursive
./pi/sync.sh --update
```

`pi/extensions/pi-proxy-router` 是独立仓库的 submodule。修改该扩展时，直接进入该目录提交并 push；dotfiles 更新到新的扩展提交后，再在外层仓库提交 submodule pointer。

如果 zsh 已经安装了本仓库版本，现有 dotfiles 更新流程会在成功 pull 后自动调用 `pi/sync.sh --update`。

## 7. 不自动处理的可选组件

以下内容不属于默认 Pi 配置恢复流程：

- Pi Web systemd service
- Pi Web 密码和环境文件
- remote peers
- sessions
- `memory-vault`

需要这些组件时，先向用户说明并单独配置；不要从其他电脑复制运行时凭据。
