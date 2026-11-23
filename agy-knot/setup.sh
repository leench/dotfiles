#!/usr/bin/env bash
# 安装 agy-knot CLI 到本机（优先使用 uv tool，回退到包内 .venv + ~/.local/bin 软链）

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if command -v uv >/dev/null 2>&1; then
    echo "使用 uv tool 安装 agy-knot..."
    uv tool install --force "$SCRIPT_DIR"
    exit 0
fi

VENV_DIR="$HOME/.local/share/agy-knot-venv"
BIN_DIR="$HOME/.local/bin"

echo "未检测到 uv，回退使用 python3 venv 安装到 $VENV_DIR..."
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install --force-reinstall "$SCRIPT_DIR"

mkdir -p "$BIN_DIR"
ln -sf "$VENV_DIR/bin/agy-knot" "$BIN_DIR/agy-knot"
echo "已链接 $BIN_DIR/agy-knot -> $VENV_DIR/bin/agy-knot"
