#!/usr/bin/env bash

set -euo pipefail

if [ "$(uname -s)" = "Darwin" ]; then
    mkdir -p "$HOME/Library/Application Support/lazygit"
    ln -sfn "$HOME/.config/lazygit/config.yml" \
        "$HOME/Library/Application Support/lazygit/config.yml"
fi
