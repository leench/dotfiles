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
