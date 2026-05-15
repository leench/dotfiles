#!/usr/bin/env bash
set -euo pipefail

: "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY is required}"

exec codeproxy \
  --config "$HOME/.codex/codeproxy/deepseek-flash.json" \
  --apikey "$DEEPSEEK_API_KEY"
