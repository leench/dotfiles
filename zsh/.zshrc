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
            # 脏检查：如果有未提交的改动，进行提醒
            if [[ -n $(git -C ~/dotfiles status --porcelain) ]]; then
                echo -e "\033[0;33m检测到 dotfiles 有未提交的本地更改，请记得处理。\033[0m"
            fi

            echo "正在检查 dotfiles 远程更新..."
            # 尝试获取远程状态 (设置较短的超时以防网络问题挂起)
            if command -v timeout &> /dev/null; then
                timeout 10 git -C ~/dotfiles fetch --quiet origin main 2>/dev/null
            else
                git -C ~/dotfiles fetch --quiet origin main 2>/dev/null
            fi

            local remote_updates=$(git -C ~/dotfiles rev-list HEAD..origin/main 2>/dev/null)
            if [[ -n "$remote_updates" ]]; then
                echo -e "\n\033[0;32m✨ 发现 dotfiles 远程更新！\033[0m"
                echo "------------------------------------------------"
                echo "变更文件："
                git -C ~/dotfiles diff --name-status HEAD..origin/main
                echo "------------------------------------------------"
                echo "最新提交："
                git -C ~/dotfiles log HEAD..origin/main --oneline -n 5
                echo "------------------------------------------------"
                
                # 使用 zsh 内置的 read -q 进行确认 (y/n)
                if read -q "choice?是否现在拉取更新? (y/n) "; then
                    echo -e "\n\n正在更新 (git pull --rebase --autostash)..."
                    if git -C ~/dotfiles pull --rebase --autostash origin main; then
                        echo -e "\033[0;32m✅ 更新成功！\033[0m"
                        echo "$today" > "$cache_file"
                    else
                        echo -e "\033[0;31m❌ 更新失败，请尝试手动解决冲突。\033[0m"
                    fi
                else
                    echo -e "\n\033[0;34m已跳过更新，今日不再提醒。\033[0m"
                    echo "$today" > "$cache_file"
                fi
            else
                # 没有更新，标记今日已检查
                echo "$today" > "$cache_file"
            fi
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
# 2. 基础环境变量与路径设置
# ===============================================================
export PATH="$HOME/.local/bin:$PATH"
export EDITOR='nvim'

# 解决 Locale 警告，保持终端一致性
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

# 开启终端真彩色支持
export COLORTERM=truecolor

# 禁用 Kitty 的 ssh 别名/集成
export KITTY_SHELL_INTEGRATION="no-ssh"

# ===============================================================
# 3. Oh My Zsh 核心配置
# ===============================================================
export ZSH="$HOME/.oh-my-zsh"

# 主题设置
ZSH_THEME="powerlevel10k/powerlevel10k"

# 插件列表
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
    command-not-found 
    fzf
)

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
source <(fzf --zsh)
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# Poetry & Python 环境
export UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
export OLLAMA_API_BASE=http://127.0.0.1:11434

# Docker Completions
fpath=(/Users/leen/.docker/completions $fpath)
autoload -Uz compinit && compinit

# GUI 环境变量 (仅在有显示环境时)
if [[ -n "$DISPLAY" || -n "$WAYLAND_DISPLAY" ]]; then
    export QT_QPA_PLATFORMTHEME=kvantum
    export QT_STYLE_OVERRIDE=kvantum
fi

# ===============================================================
# 5. 别名设置 (Aliases)
# ===============================================================

# 通用别名
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

# 浏览器调试
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

# SSH 增强与 FZF 选择器
ssh() {
    local target="$1"
    if [[ "$target" == "aliyun" ]]; then
        if ! (ssh -O check aliyun 2>/dev/null && ssh -q -o ConnectTimeout=1 aliyun true 2>/dev/null); then
            ssh -O exit aliyun 2>/dev/null
            $HOME/.local/bin/ali.exp
            sleep 0.5
        fi
        [[ "$target" == "aaliyun" ]] && target="aliyun"
    fi

    # 强制使用 xterm-256color 以确保远程兼容性
    TERM=xterm-256color command ssh "$target" "${@:2}"
}

s() {
    local config_file="$HOME/.ssh/config"
    [ ! -f "$config_file" ] && return 1
    local target=$(grep -i "^Host " "$config_file" | awk '{print $2}' | grep -v "\*" | fzf \
        --height 40% --reverse --border --header "Select SSH Host")
    [ -n "$target" ] && ssh "$target"
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

# 快捷键绑定
bindkey '^l' autosuggest-accept

# ===============================================================
# 7. 外部配置加载 (放在最后以确保覆盖)
# ===============================================================

# 加载私密变量 (如 API Keys)
[[ -f ~/.zshrc_secret ]] && source ~/.zshrc_secret

# 加载 Powerlevel10k 样式配置
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
[[ -f ~/.zshrc.local ]] && source ~/.zshrc.local

# 确保不使用 kitten ssh (禁用别名)
unalias ssh 2>/dev/null
