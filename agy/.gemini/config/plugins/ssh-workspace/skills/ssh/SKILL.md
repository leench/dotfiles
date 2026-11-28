---
name: ssh
description: >-
  Quick slash command for managing and connecting to remote SSH workspaces
  (/ssh <alias|host>, /ssh list, /ssh status, /ssh off, /ssh alias).
---

# /ssh Command Handler

Parse the arguments following `/ssh` and execute the matching `ssh-workspace` MCP tool immediately. Keep responses concise.

## Argument Dispatch

- Empty or `list`:
  Call `ssh_list_hosts` and show the available workspace aliases and `~/.ssh/config` hosts.
- `status`:
  Call `ssh_status`.
- `off` or `disconnect`:
  Call `ssh_disconnect`.
- `alias <name> <host> <cwd>`:
  Call `ssh_set_alias(name=name, host=host, cwd=cwd)`.
- `unalias <name>`:
  Call `ssh_remove_alias(name=name)`.
- `<target> [cwd]` (anything else, e.g. `my-project`, `devbox`, `devbox /srv/app`, `devbox:/srv/app`):
  Call `ssh_connect(host=target, cwd=optional_cwd)`. Once connected, report the connected host, alias (if any), and remote working directory.
