#!/bin/bash

# --- 交互式 Dotfiles 安装脚本 ---

set -e

DOTFILES_DIR="$HOME/dotfiles"
cd "$DOTFILES_DIR"

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Interactive Dotfiles Setup...${NC}"

# --- 1. 自动检测平台 ---
OS="$(uname -s)"
case "$OS" in
    Darwin)  DETECTED="macOS" ;;
    Linux)   
        if [[ -n "$WAYLAND_DISPLAY" || -n "$DISPLAY" ]]; then
            DETECTED="linux-desktop"
        else
            DETECTED="linux-server"
        fi
        ;;
    *)       DETECTED="unknown" ;;
esac

echo -e "${YELLOW}📍 Detected Platform: $DETECTED${NC}"

# --- 2. 检查基础依赖 (Stow) ---
if ! command -v stow &> /dev/null; then
    echo -e "${RED}📦 Stow not found.${NC}"
    read -p "Install it now? [y/N] " install_stow
    if [[ "$install_stow" =~ ^[Yy]$ ]]; then
        if [[ "$OS" == "Darwin" ]]; then
            if ! command -v brew &> /dev/null; then
                echo "Installing Homebrew first..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            fi
            brew install stow
        elif command -v pacman &> /dev/null; then
            sudo pacman -S --noconfirm stow
        elif command -v apt &> /dev/null; then
            sudo apt update && sudo apt install -y stow
        else
            echo -e "${RED}❌ Could not find a supported package manager.${NC}"
            exit 1
        fi
    else
        echo -e "${RED}❌ Stow is required to continue.${NC}"
        exit 1
    fi
fi

# --- 3. 选择安装包 ---
CORE_PACKAGES=(nvim zsh tmux ssh)
GUI_PACKAGES=(kitty mpv niri waybar rmpc vicinae wezterm)
SELECTED_PACKAGES=()

echo -e "\n${BLUE}📦 Package Selection:${NC}"

# 3.1 核心包选择
read -p "Install ALL CORE packages? (${CORE_PACKAGES[*]}) [Y/n] " select_core
if [[ ! "$select_core" =~ ^[Nn]$ ]]; then
    SELECTED_PACKAGES+=("${CORE_PACKAGES[@]}")
else
    for pkg in "${CORE_PACKAGES[@]}"; do
        read -p "   -> Install $pkg? [y/N] " ans
        [[ "$ans" =~ ^[Yy]$ ]] && SELECTED_PACKAGES+=("$pkg")
    done
fi

# 3.2 GUI 包选择
if [[ "$DETECTED" == "linux-desktop" || "$DETECTED" == "macOS" ]]; then
    echo -e "\n${YELLOW}🖥️ GUI environment detected.${NC}"
    read -p "Install GUI configurations? [y/N] " do_gui
    if [[ "$do_gui" =~ ^[Yy]$ ]]; then
        read -p "   -> Install ALL GUI packages? [Y/n] " all_gui
        if [[ ! "$all_gui" =~ ^[Nn]$ ]]; then
            SELECTED_PACKAGES+=("${GUI_PACKAGES[@]}")
        else
            for pkg in "${GUI_PACKAGES[@]}"; do
                read -p "      -> Install $pkg? [y/N] " ans
                [[ "$ans" =~ ^[Yy]$ ]] && SELECTED_PACKAGES+=("$pkg")
            done
        fi
    fi
fi

# --- 4. 执行 Stow ---
if [ ${#SELECTED_PACKAGES[@]} -eq 0 ]; then
    echo -e "${YELLOW}⚠️ No packages selected. Skipping linking.${NC}"
else
    echo -e "\n${BLUE}🔗 Linking selected configurations...${NC}"
    for pkg in "${SELECTED_PACKAGES[@]}"; do
        if [ -d "$pkg" ]; then
            echo -e "   -> Stowing ${GREEN}$pkg${NC}"
            stow -R "$pkg"
        else
            echo -e "   ${RED}⚠️ Warning: Package directory '$pkg' not found.${NC}"
        fi
    done
fi

# --- 5. 环境初始化 ---
echo -e "\n${BLUE}🐚 Zsh & Plugins Setup:${NC}"
read -p "Setup/Update Zsh plugins & Powerlevel10k? [y/N] " setup_zsh
if [[ "$setup_zsh" =~ ^[Yy]$ ]]; then
    # Oh My Zsh
    if [ ! -d "$HOME/.oh-my-zsh" ]; then
        echo "   -> Installing Oh My Zsh..."
        sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
        rm -f "$HOME/.zshrc"
        stow -R zsh
    fi

    # Zsh Plugins
    ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
    declare -A ZSH_PLUGINS=(
        ["themes/powerlevel10k"]="https://github.com/romkatv/powerlevel10k.git"
        ["plugins/zsh-autosuggestions"]="https://github.com/zsh-users/zsh-autosuggestions"
        ["plugins/zsh-syntax-highlighting"]="https://github.com/zsh-users/zsh-syntax-highlighting.git"
        ["plugins/you-should-use"]="https://github.com/MichaelAquilina/zsh-you-should-use.git"
        ["plugins/zsh-history-substring-search"]="https://github.com/zsh-users/zsh-history-substring-search"
    )

    for path in "${!ZSH_PLUGINS[@]}"; do
        if [ ! -d "$ZSH_CUSTOM/$path" ]; then
            echo "   -> Installing: ${path##*/}"
            git clone --depth=1 "${ZSH_PLUGINS[$path]}" "$ZSH_CUSTOM/$path"
        else
            echo "   -> Plugin ${path##*/} already exists."
        fi
    done
fi

# --- 6. Tmux TPM ---
read -p "📟 Install Tmux Plugin Manager (TPM)? [y/N] " setup_tpm
if [[ "$setup_tpm" =~ ^[Yy]$ ]]; then
    if [ ! -d "$HOME/.tmux/plugins/tpm" ]; then
        echo "   -> Installing TPM..."
        git clone https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"
    else
        echo "   -> TPM already exists."
    fi
fi

echo -e "\n${GREEN}✅ Setup Complete!${NC}"
echo "Note: If this is a new Zsh install, please restart your shell."
