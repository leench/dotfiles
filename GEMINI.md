# Dotfiles Engineering Standards

## 1. 跨平台兼容性规则 (Platform Compatibility)
项目支持以下三种主要环境，配置文件应做好隔离与兼容：
- **macOS**: 主要开发环境，使用 Homebrew 管理包。
- **Linux Local (Arch/Niri)**: 桌面环境，使用 Wayland (Niri) 和 Waybar。
- **Remote Server (Linux)**: 远程生产/开发服务器，仅限最小化 CLI 配置。

### 核心区分逻辑 (Core Logic)
在 Shell 脚本或 Zsh 配置中，使用以下逻辑区分平台：
```zsh
case "$(uname -s)" in
    Darwin)
        # macOS specific logic
        ;;
    Linux)
        if [[ -n "$WAYLAND_DISPLAY" || -n "$DISPLAY" ]]; then
            # Desktop Linux
        else
            # Remote/Headless Linux
        fi
        ;;
esac
```

## 2. 目录结构规范
- `core/`: (规划中) 存放所有平台通用的配置。
- `gui/`: (规划中) 存放仅限桌面环境的配置 (Waybar, Niri, Kitty)。
- `zsh/`: 存放 Zsh 配置，内部应区分 `zshrc`（通用）和 `*.local`（机器特定）。

## 3. 自动化与更新
- **自动拉取**: 每天第一次启动 Shell 时，后台执行 `git pull --rebase`。
- **Stow 部署**: 使用 `stow` 进行符号链接管理。`install.sh` 应能识别系统并按需部署包。

## 4. AI 维护准则
- 修改配置时，优先检查是否存在平台冲突。
- 敏感信息（API Key, Tokens）必须存放在 `~/.zshrc_secret` 中，严禁提交到 Git。
- 增加新工具配置时，需同步更新 `install.sh` 的安装逻辑。
