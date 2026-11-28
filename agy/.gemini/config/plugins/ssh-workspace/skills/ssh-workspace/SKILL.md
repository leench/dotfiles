---
name: ssh-workspace
description: >-
  Use this skill when the user wants to browse, search, read, edit, or run
  commands inside a remote SSH workspace via the ssh-workspace MCP server.
---

# SSH Remote Workspace Workflow

Follow this workflow to operate on a remote codebase over SSH with connection multiplexing.

## Steps

1. **Discover hosts and workspace aliases** (if target is unknown):
   Call `ssh_list_hosts` to list configured workspace aliases (`~/.config/ssh-workspace/aliases.json`) and host aliases from `~/.ssh/config`.
   Use `ssh_set_alias(name, host, cwd)` or `ssh_remove_alias(name)` when the user wants to save or delete a project shortcut.
2. **Connect to the remote workspace**:
   Call `ssh_connect` with `host` (a workspace alias like `my-project`, an `~/.ssh/config` host, `user@hostname`, or `host:/remote/path`) and optional `cwd`. This establishes/reuses an SSH ControlMaster socket, resolves the remote home and working directory, and detects whether `rg` is installed.
3. **Explore and search**:
   - Use `ssh_list_dir` to inspect directory structure.
   - Use `ssh_search` to search code (uses `rg` when available, otherwise `grep -rn`).
4. **Read and edit files**:
   - Use `ssh_read_file` with `start_line` and `end_line` to read targeted ranges.
   - Use `ssh_edit_file` for exact string replacements (returns a unified diff) or `ssh_write_file` to create/overwrite/append files.
5. **Run remote commands**:
   - Use `ssh_exec` to run builds, tests, git commands, or scripts inside the remote `cwd`.
6. **Check or close session**:
   - Call `ssh_status` to inspect active host, `cwd`, and ControlMaster liveness.
   - Call `ssh_disconnect` when finished to close the ControlMaster connection and clear session state.
