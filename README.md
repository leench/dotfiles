# dotfiles

个人 dotfiles，使用 GNU Stow 管理。

## 用法

查看可安装包：

```bash
./install.sh --list
```

安装一个或多个包：

```bash
./install.sh tmux
./install.sh zsh tmux codex
```

安装全部包：

```bash
./install.sh all
```

## 约定

- 每个一级目录都是一个可独立安装的包。
- 包内如有额外初始化逻辑，放在自己的 `setup.sh` 中。
- 例如：
  - `tmux/setup.sh`：安装 TPM
  - `zsh/setup.sh`：安装 Oh My Zsh 与插件
- 敏感信息不要提交到仓库，shell 密钥放在本机私有文件中。

## Pi 配置

Pi 使用独立的 `pi` 包和同步脚本：

```bash
./install.sh pi
~/dotfiles/pi/sync.sh --check
```

`pi/sync.sh` 同步仓库中的公用 agents、prompts、skills、extensions 和 `pi/defaults/common.json` 中显式配置的 settings 字段；本机私有 package/extension 以及 `auth.json`、sessions、缓存和依赖仍保留在本机。Pi 公用 package 版本记录在 `pi/packages.txt`，settings 中额外的私有 package 会被保留。dotfiles 更新成功后，zsh 更新流程会自动执行 `pi/sync.sh --update`。
