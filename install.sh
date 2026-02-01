#!/bin/bash

set -e # Exit on error

DOTFILES_DIR="$HOME/dotfiles"

echo "🚀 Starting Dotfiles Setup..."

# --- 1. Link Configurations (Stow) ---
echo "🔗 Linking config files with Stow..."
cd "$DOTFILES_DIR"
# List of packages to stow. Add more as needed.
# Only including cross-platform CLI tools by default.
PACKAGES=(nvim zsh tmux ssh)

for pkg in "${PACKAGES[@]}"; do
    if [ -d "$pkg" ]; then
        echo "   -> Stowing $pkg"
        stow -R "$pkg"
    else
        echo "   ⚠️ Warning: Package directory '$pkg' not found in dotfiles."
    fi
done

# --- 2. Setup Zsh (Oh My Zsh + Plugins + P10k) ---
echo "🐚 Setting up Zsh environment..."

# Install Oh My Zsh if missing
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    echo "   -> Installing Oh My Zsh..."
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
    # Remove the .zshrc created by installer so stow can link ours
    rm -f "$HOME/.zshrc"
    stow -R zsh
else
    echo "   -> Oh My Zsh already installed."
fi

# Install Powerlevel10k Theme
P10K_DIR="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k"
if [ ! -d "$P10K_DIR" ]; then
    echo "   -> Installing Powerlevel10k..."
    git clone --depth=1 https://github.com/romkatv/powerlevel10k.git "$P10K_DIR"
else
    echo "   -> Powerlevel10k already installed."
fi

# Install Zsh Plugins (Autosuggestions & Syntax Highlighting)
ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
PLUGINS_DIR="$ZSH_CUSTOM/plugins"

declare -A ZSH_PLUGINS=(
    ["zsh-autosuggestions"]="https://github.com/zsh-users/zsh-autosuggestions"
    ["zsh-syntax-highlighting"]="https://github.com/zsh-users/zsh-syntax-highlighting.git"
    ["you-should-use"]="https://github.com/MichaelAquilina/zsh-you-should-use.git"
    ["z"]="https://github.com/agkozak/zsh-z" 
)

for plugin in "${!ZSH_PLUGINS[@]}"; do
    if [ ! -d "$PLUGINS_DIR/$plugin" ]; then
        echo "   -> Installing plugin: $plugin"
        git clone "${ZSH_PLUGINS[$plugin]}" "$PLUGINS_DIR/$plugin"
    else
        echo "   -> Plugin $plugin already installed."
    fi
done

# --- 3. Setup Tmux (TPM) ---
echo "📟 Setting up Tmux..."
TPM_DIR="$HOME/.tmux/plugins/tpm"
if [ ! -d "$TPM_DIR" ]; then
    echo "   -> Installing Tmux Plugin Manager (TPM)..."
    git clone https://github.com/tmux-plugins/tpm "$TPM_DIR"
    echo "   -> ⚠️  IMPORTANT: Open tmux and press 'Prefix + I' to install plugins!"
else
    echo "   -> TPM already installed."
fi

# --- 4. Neovim ---
echo "📝 Neovim (LazyVim) will auto-install on first run."

echo "✅ Setup Complete! Please restart your shell or log out and back in."
