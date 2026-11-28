#!/usr/bin/env python3
"""Antigravity CLI statusLine script for ssh-workspace."""

from __future__ import annotations

import json
import os
import sys


def _is_pid_alive(pid: int) -> bool:
    """Return True if the given PID exists (or permission denied)."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def main() -> int:
    try:
        sys.stdin.read()
    except OSError:
        pass

    uid = os.getuid() if hasattr(os, "getuid") else 0
    state_path = f"/tmp/agy-ssh-mcp-{uid}/state.json"

    try:
        with open(state_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return 0

    if not isinstance(data, dict):
        return 0

    host = str(data.get("host") or "").strip()
    cwd = str(data.get("cwd") or "").strip()
    alias = str(data.get("alias") or "").strip()
    if not host or not cwd:
        return 0

    pid = data.get("pid")
    if isinstance(pid, int) and not isinstance(pid, bool):
        if not _is_pid_alive(pid):
            return 0

    if alias:
        label = f"\033[1m{alias}\033[0m ({host})"
    else:
        label = f"\033[1m{host}\033[0m"
    sys.stdout.write(f"\033[36m[SSH]\033[0m {label}:{cwd}\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
