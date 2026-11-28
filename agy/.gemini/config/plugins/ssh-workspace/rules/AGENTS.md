# SSH Remote Workspace Rules

These rules govern how the agent works with remote SSH workspaces via the `ssh-workspace` MCP server.

## Activation Scope

- Only switch to the remote SSH workflow when the user explicitly asks to work on a remote SSH host, or after `ssh_connect` has established an active remote session in this conversation.
- When working on normal local projects (no remote SSH session requested or connected), continue using standard local tools (`read_file`, `edit_file`, `write_file`, `run_command`).

## Remote Session Behavior

While a remote SSH session is active:

1. **Always use remote SSH tools** (`ssh_list_dir`, `ssh_search`, `ssh_read_file`, `ssh_edit_file`, `ssh_write_file`, `ssh_exec`) for all file exploration, search, reading, editing, writing, and command execution on the remote host.
2. **Never use local tools** (`read_file`, `edit_file`, `write_file`, `run_command`) to inspect, modify, or run commands against remote workspace paths.
3. **Host selection & aliases**: If the user asks to work remotely without specifying a host or workspace alias, call `ssh_list_hosts` first to show configured workspace aliases (`~/.config/ssh-workspace/aliases.json`) and `~/.ssh/config` entries. Users can connect directly by workspace alias (e.g. `ssh_connect(host="my-project")`) or manage aliases via `ssh_set_alias` and `ssh_remove_alias`.
4. **Connection checks**: Use `ssh_status` to check the active host and working directory if unsure, and `ssh_disconnect` when the user asks to close the remote session.
5. **Path clarity**: Report remote paths clearly as remote paths on the connected host rather than local workspace paths.
