# ===============================================================
# 0. Dotfiles 自动更新 (每日检查)
# 必须放在 p10k instant prompt 之前以避免 [WARNING]
# ===============================================================
_update_dotfiles() {
    local cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}"
    local cache_file="$cache_dir/dotfiles_update_check"
    local today=$(date +%Y-%m-%d)

    # 每天只检查一次更新
    if [[ ! -f "$cache_file" || "$(cat "$cache_file")" != "$today" ]]; then
        if [[ -d ~/dotfiles/.git ]]; then
            cd ~/dotfiles
            
            # 脏检查：如果有未提交的改动，进行提醒
            if [[ -n $(git status --porcelain) ]]; then
                echo -e "\033[0;33m检测到 dotfiles 有未提交的更改，请记得提交。\033[0m"
            fi

            echo "正在检查 dotfiles 更新..."
            # 在后台异步拉取，并使用 --autostash 处理未提交的本地改动
            (
                # 这里不需要再次 cd，因为父进程已经 cd 过了
                # --rebase --autostash 可以平滑地在拉取后重新应用你的本地修改
                if git pull --quiet --rebase --autostash origin main >/dev/null 2>&1; then
                    echo "$today" > "$cache_file"
                fi
            ) &!
        fi
    fi
}
_update_dotfiles

# ===============================================================
# 1. Powerlevel10k 即时响应 (保持在文件顶部)
# ===============================================================
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# ===============================================================
# 2. 基础环境变量与系统识别
# ===============================================================
export EDITOR='nvim'
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8
export COLORTERM=truecolor

# 路径设置 (通用)
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.devcontainers/bin:$PATH"

# 系统特定初始化
case "$(uname)" in
    "Darwin")
        # macOS Homebrew 初始化 (支持 Intel/Apple Silicon)
        [[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
        [[ -f /usr/local/bin/brew ]] && eval "$(/usr/local/bin/brew shellenv)"
        
        # macOS Docker Completions (Docker Desktop)
        if [[ -d "/Applications/Docker.app/Contents/Resources/etc" ]]; then
            fpath=(/Applications/Docker.app/Contents/Resources/etc $fpath)
        fi
        ;;
    "Linux")
        # Linux 专用补全路径 (如果手动安装了 docker-completions)
        [[ -d "$HOME/.docker/completions" ]] && fpath=($HOME/.docker/completions $fpath)
        
        # GUI 环境变量 (仅在 Linux 桌面环境下)
        if [[ -n "$DISPLAY" || -n "$WAYLAND_DISPLAY" ]]; then
            export QT_QPA_PLATFORMTHEME=kvantum
            export QT_STYLE_OVERRIDE=kvantum
            export XDG_CURRENT_DESKTOP=niri
            export QT_AUTO_SCREEN_SCALE_FACTOR=1
            export QT_QPA_PLATFORM="wayland;xcb"
        fi
        ;;
esac

# ===============================================================
# 3. Oh My Zsh 核心配置
# ===============================================================
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="powerlevel10k/powerlevel10k"

# 基础插件
plugins=(
    git 
    extract 
    z 
    sudo 
    zsh-autosuggestions 
    zsh-syntax-highlighting 
    poetry 
    you-should-use 
    history-substring-search 
    fzf
)

# 仅在 Linux 上加载 command-not-found
[[ "$(uname)" == "Linux" ]] && plugins+=(command-not-found)

# 加载 Oh My Zsh
source $ZSH/oh-my-zsh.sh

# ===============================================================
# 4. 工具与版本管理器初始化
# ===============================================================

# NVM 初始化
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# FZF 初始化与优化
export FZF_DEFAULT_OPTS="-i --height 60% --layout reverse --border"
if command -v fzf >/dev/null; then
    source <(fzf --zsh)
fi
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Poetry & Python 环境
export UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
export OLLAMA_API_BASE=http://127.0.0.1:11434

# 初始化补全系统
autoload -Uz compinit && compinit

# ===============================================================
# 5. 别名设置 (Aliases)
# ===============================================================

alias vim="nvim"
alias ssc='rm -f ~/.ssh/sockets/* && echo "SSH sockets cleared."'

# Gemini 相关
alias ge="gemini"
alias ger="gemini --resume"
alias gel="gemini --list-sessions"
alias gea="gemini --ask"
alias pge='https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 gemini'
alias pcodex='https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 codex'
alias pvim='https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 nvim'

# Poetry 常用命令
alias p="poetry"
alias pi="poetry install"
alias pr="poetry run"
alias pa="poetry add"
alias pl="poetry lock"

# 浏览器调试 (多系统适配)
case "$(uname)" in
    "Darwin")
        alias chrome-dev='"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/Google/Chrome-Debug" --lang=zh-CN'
        ;;
    "Linux")
        alias chrome-dev='google-chrome-stable --remote-debugging-port=9222 --user-data-dir="$HOME/.config/google-chrome-debug" --lang=zh-CN'
        ;;
esac

# ===============================================================
# 6. 自定义函数 (Functions)
# ===============================================================

# 代理开关
proxy() {
    export HTTP_PROXY="http://127.0.0.1:7890"
    export HTTPS_PROXY="http://127.0.0.1:7890"
    export ALL_PROXY="socks5://127.0.0.1:7890"
    export NO_PROXY="localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,*.local,*.internal"
    if [ $# -eq 0 ]; then
        echo "Proxy environment variables set."
    else
        "$@"
    fi
}
alias proxy='proxy '

# SSH 增强
ssh() {
    local target="$1"
    if [[ "$target" == "aliyun" || "$target" == "aaliyun" ]]; then
        if ! (ssh -O check aliyun 2>/dev/null && ssh -q -o ConnectTimeout=1 aliyun true 2>/dev/null); then
            ssh -O exit aliyun 2>/dev/null
            echo "1Password 正在准备 OTP..."
            [[ -f "$HOME/.local/bin/ali.exp" ]] && "$HOME/.local/bin/ali.exp"
            sleep 0.5
        fi
        [[ "$target" == "aaliyun" ]] && target="aliyun"
    fi

    if [ -n "$KITTY_PID" ]; then
        kitten ssh "$target" "${@:2}"
    else
        command ssh "$target" "${@:2}"
    fi
}

s() {
    local config_file="$HOME/.ssh/config"
    [[ ! -f "$config_file" ]] && return 1
    local target=$(grep -i "^Host " "$config_file" | awk '{print $2}' | grep -v "\*" | fzf \
        --height 40% --reverse --border --header "Select SSH Host")
    [[ -n "$target" ]] && ssh "$target"
}

# FZF SSH Widget (空格键触发)
function fzf_ssh_widget() {
  if [[ "$BUFFER" == "s" ]]; then
    local target=$(awk '/^Host / && !/\*/ {print $2}' ~/.ssh/config | fzf)
    if [ -n "$target" ]; then
      BUFFER="ssh $target"
      zle accept-line
    else
      BUFFER="s "
      zle end-of-line
    fi
  else
    zle self-insert
  fi
}
zle -N fzf_ssh_widget
bindkey ' ' fzf_ssh_widget

# 远程看图
imgcat() {
  local file=$1
  if [[ -f "$file" ]]; then
    local base64_contents=$(base64 < "$file")
    printf "\033]1337;File=name=$(echo -n "$file" | base64);inline=1;size=$(wc -c < "$file"):$base64_contents\a\n"
  else
    echo "File not found: $file"
  fi
}

bindkey '^l' autosuggest-accept

# ===============================================================
# 7. 外部配置加载 (放在最后以确保覆盖)
# ===============================================================

[[ -f ~/.zshrc_secret ]] && source ~/.zshrc_secret
[[ -f ~/.zshrc_niri ]] && source ~/.zshrc_niri
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh
