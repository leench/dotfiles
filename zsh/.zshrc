# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH

# Path to your Oh My Zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time Oh My Zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
# ZSH_THEME="robbyrussell"
ZSH_THEME="powerlevel10k/powerlevel10k"

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in $ZSH/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment one of the following lines to change the auto-update behavior
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time

# Uncomment the following line to change how often to auto-update (in days).
# zstyle ':omz:update' frequency 13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS="true"

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# You can also set it to another string to have that shown instead of the default red dots.
# e.g. COMPLETION_WAITING_DOTS="%F{yellow}waiting...%f"
# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(git extract z sudo zsh-autosuggestions zsh-syntax-highlighting poetry you-should-use history-substring-search command-not-found zsh-history-substring-search fzf)

source $ZSH/oh-my-zsh.sh

# 解决 Locale 警告：显式指定使用已生成的 en_US.UTF-8
# 这样可以消除 Perl 等工具的警告，同时保持 Kitty 字体紧凑（不被 zh_CN 拉宽）
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

# User configuration

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='nvim'
# fi

# Compilation flags
# export ARCHFLAGS="-arch $(uname -m)"

# Set personal aliases, overriding those provided by Oh My Zsh libs,
# plugins, and themes. Aliases can be placed here, though Oh My Zsh
# users are encouraged to define aliases within a top-level file in
# the $ZSH_CUSTOM folder, with .zsh extension. Examples:
# - $ZSH_CUSTOM/aliases.zsh
# - $ZSH_CUSTOM/macos.zsh
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"
alias vim="nvim"
alias ge="gemini"
alias ger="gemini --resume"
alias gel="gemini --list-sessions"
alias gen="gemini"
alias gea="gemini --ask"

# Poetry aliases
alias p="poetry"
alias pi="poetry install"
alias pr="poetry run"
alias pa="poetry add"
alias pl="poetry lock"

export UV_DEFAULT_INDEX="https://pypi.tuna.tsinghua.edu.cn/simple"
# export OPENROUTER_API_KEY="..." # Moved to ~/.zshrc_secret
export OLLAMA_API_BASE=http://127.0.0.1:11434

# 仅在有显示环境时加载 GUI 相关变量
if [[ -n "$DISPLAY" || -n "$WAYLAND_DISPLAY" ]]; then
    export QT_QPA_PLATFORMTHEME=kvantum
    export QT_STYLE_OVERRIDE=kvantum
fi

export PATH="/home/niri/.local/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# Load secrets (not tracked by git)
[[ -f ~/.zshrc_secret ]] && source ~/.zshrc_secret

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# 定义 SSH 选择函数
function fzf_ssh_widget() {
  # 只有当前命令行内容刚好是 "s" 时才触发
  if [[ "$BUFFER" == "s" ]]; then
    # 清空当前行，准备显示结果
    local target=$(grep -P "^Host ([^*]+)$" ~/.ssh/config | sed 's/Host //' | fzf)
    if [ -n "$target" ]; then
      # 将选中的主机填入命令行并自动回车执行
      BUFFER="ssh $target"
      zle accept-line
    else
      # 如果取消了选择，恢复原来的 "s " (带空格)
      BUFFER="s "
      zle end-of-line
    fi
  else
    # 其他情况，Space 键仍然只是输入一个空格
    zle self-insert
  fi
}

# 注册 Zsh 组件
zle -N fzf_ssh_widget

# 将 Space 键绑定到这个组件
bindkey ' ' fzf_ssh_widget

# 保留 s 函数作为备用 (防止脚本失效时依然可用)
function s() {
  local target=$(grep -P "^Host ([^*]+)$" ~/.ssh/config | sed 's/Host //' | fzf)
  if [ -n "$target" ]; then
    ssh "$target"
  fi
}

# FZF optimization
export FZF_DEFAULT_OPTS="-i --height 60% --layout reverse --border"
source <(fzf --zsh)

# Bind Ctrl+l to autosuggest-accept
bindkey '^l' autosuggest-accept