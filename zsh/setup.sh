#!/usr/bin/env bash

set -euo pipefail

if [ ! -d "$HOME/.oh-my-zsh" ]; then
    echo "Installing Oh My Zsh..."
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
    rm -f "$HOME/.zshrc"
    stow -R zsh
fi

ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"

plugins=(
    "themes/powerlevel10k|https://github.com/romkatv/powerlevel10k.git"
    "plugins/zsh-autosuggestions|https://github.com/zsh-users/zsh-autosuggestions"
    "plugins/zsh-syntax-highlighting|https://github.com/zsh-users/zsh-syntax-highlighting.git"
    "plugins/you-should-use|https://github.com/MichaelAquilina/zsh-you-should-use.git"
    "plugins/zsh-history-substring-search|https://github.com/zsh-users/zsh-history-substring-search"
)

for item in "${plugins[@]}"; do
    path="${item%%|*}"
    repo="${item#*|}"
    if [ ! -d "$ZSH_CUSTOM/$path" ]; then
        echo "Installing ${path##*/}..."
        git clone --depth=1 "$repo" "$ZSH_CUSTOM/$path"
    else
        echo "${path##*/} already exists."
    fi
done
