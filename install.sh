#!/usr/bin/env bash

set -euo pipefail

DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
cd "$DOTFILES_DIR"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

usage() {
    cat <<'USAGE'
Usage:
  ./install.sh <package> [package ...]
  ./install.sh --list
  ./install.sh all

Examples:
  ./install.sh tmux
  ./install.sh zsh tmux codex
USAGE
}

list_packages() {
    find . -mindepth 1 -maxdepth 1 -type d \
        ! -name '.git' \
        -exec basename {} \; | sort
}

ensure_stow() {
    if command -v stow >/dev/null 2>&1; then
        return
    fi

    echo -e "${RED}stow not found.${NC}"
    case "$(uname -s)" in
        Darwin)
            if ! command -v brew >/dev/null 2>&1; then
                echo "Homebrew is required to install stow on macOS."
                exit 1
            fi
            brew install stow
            ;;
        Linux)
            if command -v pacman >/dev/null 2>&1; then
                sudo pacman -S --noconfirm stow
            elif command -v apt >/dev/null 2>&1; then
                sudo apt update
                sudo apt install -y stow
            else
                echo "Unsupported package manager; please install stow manually."
                exit 1
            fi
            ;;
        *)
            echo "Unsupported platform; please install stow manually."
            exit 1
            ;;
    esac
}

install_package() {
    local pkg="$1"

    if [ ! -d "$pkg" ]; then
        echo -e "${RED}Unknown package: $pkg${NC}"
        return 1
    fi

    echo -e "${BLUE}==> $pkg${NC}"
    echo -e "   stow ${GREEN}$pkg${NC}"
    stow -R "$pkg"

    if [ -x "$pkg/setup.sh" ]; then
        echo "   run $pkg/setup.sh"
        "$pkg/setup.sh"
    fi
}

main() {
    if [ "$#" -eq 0 ]; then
        usage
        exit 1
    fi

    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        --list)
            list_packages
            exit 0
            ;;
    esac

    ensure_stow

    local packages=()
    if [ "$1" = "all" ]; then
        while IFS= read -r pkg; do
            packages+=("$pkg")
        done < <(list_packages)
    else
        packages=("$@")
    fi

    for pkg in "${packages[@]}"; do
        install_package "$pkg"
    done

    echo -e "${GREEN}Done.${NC}"
}

main "$@"
