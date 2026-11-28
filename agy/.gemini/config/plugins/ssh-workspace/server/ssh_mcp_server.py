#!/usr/bin/env python3
"""Zero-dependency Stdio MCP Server for remote SSH workspaces."""

from __future__ import annotations

import difflib
import glob
import json
import os
import posixpath
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

SERVER_NAME = "ssh-workspace"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL_VERSION = "2025-03-26"

MAX_READ_LINES = 800
MAX_READ_BYTES = 45000
MAX_EXEC_OUTPUT_CHARS = 40000
DEFAULT_EXEC_TIMEOUT = 60
MAX_EXEC_TIMEOUT = 600
MAX_LIST_ENTRIES = 500
DEFAULT_SEARCH_RESULTS = 100
MAX_SEARCH_RESULTS = 500

PRUNE_DIRS = (".git", "node_modules", "__pycache__", ".venv")


def _control_dir() -> str:
    """Return per-user ControlMaster socket directory path."""
    uid = os.getuid() if hasattr(os, "getuid") else 0
    return f"/tmp/agy-ssh-mcp-{uid}"


def _ensure_control_dir() -> str:
    """Create the ControlMaster directory with 0700 permissions."""
    ctrl_dir = _control_dir()
    os.makedirs(ctrl_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(ctrl_dir, 0o700)
    except OSError:
        pass
    return ctrl_dir


def _control_path() -> str:
    """Return the SSH ControlPath template."""
    return os.path.join(_ensure_control_dir(), "cm-%C")


def _state_file_path() -> str:
    """Return the per-user runtime state file path for statusline integration."""
    return os.path.join(_ensure_control_dir(), "state.json")


def _aliases_file_path() -> Path:
    """Return the workspace aliases JSON file path."""
    env_path = (os.environ.get("SSH_WORKSPACE_ALIASES_FILE") or "").strip()
    if env_path:
        return Path(env_path).expanduser()
    xdg_config = (os.environ.get("XDG_CONFIG_HOME") or "").strip()
    config_root = Path(xdg_config).expanduser() if xdg_config else (Path.home() / ".config")
    return config_root / "ssh-workspace" / "aliases.json"


def _load_aliases() -> dict[str, dict[str, str]]:
    """Load and normalize workspace aliases from aliases.json."""
    path = _aliases_file_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    aliases: dict[str, dict[str, str]] = {}
    for name, val in raw.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(val, dict):
            continue
        host = val.get("host")
        cwd = val.get("cwd")
        if isinstance(host, str) and host.strip() and isinstance(cwd, str):
            aliases[name.strip()] = {"host": host.strip(), "cwd": cwd.strip()}
    return aliases


def _save_aliases(aliases: dict[str, dict[str, str]]) -> None:
    """Atomically save workspace aliases to aliases.json."""
    path = _aliases_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    content = json.dumps(aliases, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    try:
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(tmp_path, path)
    except OSError:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise


def _base_ssh_args() -> list[str]:
    """Return base SSH arguments with ControlMaster multiplexing enabled."""
    return [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ControlMaster=auto",
        "-o",
        f"ControlPath={_control_path()}",
        "-o",
        "ControlPersist=10m",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
    ]


def _resolve_remote_path(
    path: str, cwd: str, home: Optional[str] = None
) -> str:
    """Resolve a remote POSIX path relative to cwd or remote home."""
    raw = (path or ".").strip() or "."
    if raw == "~":
        return posixpath.normpath(home) if home else "~"
    if raw.startswith("~/"):
        rel = raw[2:]
        if home:
            return posixpath.normpath(posixpath.join(home, rel))
        return raw
    if raw.startswith("/"):
        return posixpath.normpath(raw)
    base = cwd or home or "/"
    return posixpath.normpath(posixpath.join(base, raw))


def _parse_ssh_config(config_path: str) -> list[dict[str, str]]:
    """Parse SSH config and Include files, returning non-wildcard Host aliases."""
    visited: set[Path] = set()
    entries: list[dict[str, str]] = []
    seen_hosts: set[str] = set()

    def _parse_file(file_path: Path) -> None:
        try:
            resolved = file_path.expanduser().resolve()
        except OSError:
            return
        if resolved in visited or not resolved.is_file():
            return
        visited.add(resolved)

        try:
            lines = resolved.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return

        current_aliases: list[str] = []
        current_meta: dict[str, str] = {}

        def _flush_block() -> None:
            for alias in current_aliases:
                if any(ch in alias for ch in ("*", "?", "!")):
                    continue
                if alias in seen_hosts:
                    continue
                seen_hosts.add(alias)
                entries.append(
                    {
                        "host": alias,
                        "hostname": current_meta.get("hostname", ""),
                        "user": current_meta.get("user", ""),
                        "port": current_meta.get("port", ""),
                        "proxyjump": current_meta.get("proxyjump", ""),
                    }
                )

        for raw_line in lines:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            # Strip inline comments outside quotes conservatively if needed,
            # or split key/value with shlex-aware fallback.
            try:
                tokens = shlex.split(line, comments=True)
            except ValueError:
                tokens = line.split()
            if not tokens:
                continue

            key_raw = tokens[0]
            if "=" in key_raw and len(tokens) == 1:
                k, v = key_raw.split("=", 1)
                key = k.lower()
                vals = [v] if v else []
            elif "=" in key_raw and not key_raw.endswith("="):
                k, v = key_raw.split("=", 1)
                key = k.lower()
                vals = [v] + tokens[1:]
            else:
                key = key_raw.rstrip("=").lower()
                vals = tokens[1:]
                if vals and vals[0] == "=":
                    vals = vals[1:]

            if not vals:
                continue

            if key == "include":
                for pattern in vals:
                    p = os.path.expanduser(pattern)
                    if not os.path.isabs(p):
                        p = os.path.join(os.path.expanduser("~/.ssh"), p)
                    for match in sorted(glob.glob(p)):
                        _parse_file(Path(match))
                continue

            if key == "match":
                _flush_block()
                current_aliases = []
                current_meta = {}
                continue

            if key == "host":
                _flush_block()
                current_aliases = vals
                current_meta = {}
                continue

            if current_aliases and key in ("hostname", "user", "port", "proxyjump"):
                if key not in current_meta:
                    current_meta[key] = " ".join(vals)

        _flush_block()

    _parse_file(Path(config_path))
    return entries


def _truncate_text(text: str, limit: int) -> tuple[str, bool]:
    """Truncate text to limit chars if exceeded."""
    if len(text) <= limit:
        return text, False
    truncated = text[:limit] + f"\n...[truncated, total {len(text)} chars]"
    return truncated, True


class SshSessionState:
    """In-memory state and SSH execution helpers for the MCP server."""

    def __init__(self) -> None:
        self.current_host: Optional[str] = None
        self.current_cwd: Optional[str] = None
        self.current_alias: Optional[str] = None
        self.host_homes: dict[str, str] = {}
        self.host_has_rg: dict[str, bool] = {}

    def _write_state_file(self) -> None:
        """Atomically persist active host/cwd and server PID for TUI statusline."""
        if not self.current_host:
            return
        state_path = _state_file_path()
        tmp_path = f"{state_path}.tmp.{os.getpid()}"
        payload = {
            "host": self.current_host,
            "cwd": self.current_cwd or "",
            "alias": self.current_alias or "",
            "pid": os.getpid(),
            "updated_at": int(time.time()),
        }
        try:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=True)
            os.replace(tmp_path, state_path)
        except OSError:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass

    def _clear_state_file(self) -> None:
        """Remove the runtime state file only if owned by this process or missing PID."""
        state_path = _state_file_path()
        try:
            with open(state_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return
        owner_pid = data.get("pid") if isinstance(data, dict) else None
        if owner_pid is None or owner_pid == os.getpid():
            try:
                os.remove(state_path)
            except OSError:
                pass

    def _target_host(self, host: Optional[str]) -> str:
        target = (host or "").strip() or self.current_host
        if not target:
            raise ValueError(
                "No SSH host connected. Call ssh_connect(host) first, "
                "or call ssh_list_hosts() to inspect ~/.ssh/config."
            )
        return target

    def _target_cwd(self, host: str, cwd: Optional[str] = None) -> str:
        home = self.host_homes.get(host)
        if cwd is not None and cwd.strip():
            base = self.current_cwd if host == self.current_host and self.current_cwd else (home or "/")
            return _resolve_remote_path(cwd, base, home)
        if host == self.current_host and self.current_cwd:
            return self.current_cwd
        return home or "/"

    def _run_ssh(
        self,
        host: str,
        remote_cmd: str,
        *,
        stdin_bytes: Optional[bytes] = None,
        timeout: int = DEFAULT_EXEC_TIMEOUT,
    ) -> subprocess.CompletedProcess[bytes]:
        cmd = _base_ssh_args() + [host, remote_cmd]
        return subprocess.run(
            cmd,
            input=stdin_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )

    def _run_ssh_text(
        self,
        host: str,
        remote_cmd: str,
        *,
        stdin_text: Optional[str] = None,
        timeout: int = DEFAULT_EXEC_TIMEOUT,
    ) -> tuple[int, str, str]:
        stdin_bytes = stdin_text.encode("utf-8") if stdin_text is not None else None
        try:
            proc = self._run_ssh(host, remote_cmd, stdin_bytes=stdin_bytes, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"SSH command timed out after {timeout}s on host '{host}'.") from exc
        stdout = proc.stdout.decode("utf-8", errors="replace")
        stderr = proc.stderr.decode("utf-8", errors="replace")
        return proc.returncode, stdout, stderr

    def _ensure_home_and_rg(self, host: str) -> tuple[str, bool]:
        if host in self.host_homes and host in self.host_has_rg:
            return self.host_homes[host], self.host_has_rg[host]
        probe_script = 'printf "%s\\n" "$HOME"; command -v rg >/dev/null 2>&1 && echo 1 || echo 0'
        rc, out, err = self._run_ssh_text(host, f"sh -c {shlex.quote(probe_script)}", timeout=20)
        if rc != 0:
            raise RuntimeError(f"SSH probe failed for '{host}' (exit {rc}): {err.strip()}")
        lines = out.splitlines()
        home = lines[0].strip() if lines else "/"
        has_rg = len(lines) > 1 and lines[1].strip() == "1"
        self.host_homes[host] = home
        self.host_has_rg[host] = has_rg
        return home, has_rg

    def _remote_quote_path(self, resolved_path: str) -> str:
        """Quote a remote path, expanding leading ~ in shell if home is unknown."""
        if resolved_path == "~":
            return '"$HOME"'
        if resolved_path.startswith("~/"):
            return '"$HOME"/' + shlex.quote(resolved_path[2:])
        return shlex.quote(resolved_path)

    # ---- Tool implementations ----

    def list_hosts(self) -> str:
        aliases = _load_aliases()
        lines: list[str] = []
        if aliases:
            lines.append(f"Workspace aliases ({_aliases_file_path()}):")
            for name in sorted(aliases):
                entry = aliases[name]
                cwd_disp = entry["cwd"] or "~"
                marker = " [connected]" if name == self.current_alias else ""
                lines.append(f"- {name} -> {entry['host']}:{cwd_disp}{marker}")
        else:
            lines.append(f"No workspace aliases configured ({_aliases_file_path()}).")

        config_path = os.path.expanduser("~/.ssh/config")
        hosts = _parse_ssh_config(config_path)
        if not hosts:
            lines.append(
                f"No non-wildcard Host aliases found in {config_path}. "
                "You can still pass user@hostname directly to ssh_connect."
            )
            return "\n".join(lines)

        lines.append(f"Found {len(hosts)} host(s) in {config_path}:")
        for item in hosts:
            details = []
            if item["hostname"]:
                details.append(f"HostName={item['hostname']}")
            if item["user"]:
                details.append(f"User={item['user']}")
            if item["port"]:
                details.append(f"Port={item['port']}")
            if item["proxyjump"]:
                details.append(f"ProxyJump={item['proxyjump']}")
            suffix = f" ({', '.join(details)})" if details else ""
            marker = " [connected]" if item["host"] == self.current_host else ""
            lines.append(f"- {item['host']}{suffix}{marker}")
        return "\n".join(lines)

    def set_alias(self, name: str, host: str, cwd: str) -> str:
        alias_name = (name or "").strip()
        target_host = (host or "").strip()
        target_cwd = (cwd or "").strip()
        if not alias_name:
            raise ValueError("'name' is required.")
        if any(ch.isspace() for ch in alias_name):
            raise ValueError("'name' must not contain whitespace.")
        if not target_host:
            raise ValueError("'host' is required.")
        if not target_cwd:
            raise ValueError("'cwd' is required.")

        aliases = _load_aliases()
        aliases[alias_name] = {"host": target_host, "cwd": target_cwd}
        _save_aliases(aliases)
        return f"Saved alias '{alias_name}' -> {target_host}:{target_cwd} in {_aliases_file_path()}."

    def remove_alias(self, name: str) -> str:
        alias_name = (name or "").strip()
        if not alias_name:
            raise ValueError("'name' is required.")
        aliases = _load_aliases()
        if alias_name not in aliases:
            raise ValueError(f"Alias '{alias_name}' not found in {_aliases_file_path()}.")
        del aliases[alias_name]
        _save_aliases(aliases)
        return f"Removed alias '{alias_name}' from {_aliases_file_path()}."

    def connect(self, host: str, cwd: Optional[str] = None) -> str:
        host_input = (host or "").strip()
        if not host_input:
            raise ValueError("'host' is required.")

        aliases = _load_aliases()
        resolved_alias: Optional[str] = None
        actual_host = host_input
        actual_cwd: Optional[str] = cwd.strip() if (cwd and cwd.strip()) else None

        if host_input in aliases:
            resolved_alias = host_input
            actual_host = aliases[host_input]["host"]
            if not actual_cwd:
                actual_cwd = aliases[host_input]["cwd"] or None
        elif actual_cwd is None and ":" in actual_host and "[" not in actual_host:
            maybe_host, maybe_path = actual_host.split(":", 1)
            if maybe_host and (
                maybe_path.startswith("/") or maybe_path == "~" or maybe_path.startswith("~/")
            ):
                actual_host = maybe_host
                actual_cwd = maybe_path

        target_cwd_expr = '"$HOME"'
        if actual_cwd:
            if actual_cwd == "~":
                target_cwd_expr = '"$HOME"'
            elif actual_cwd.startswith("~/"):
                target_cwd_expr = '"$HOME"/' + shlex.quote(actual_cwd[2:])
            else:
                target_cwd_expr = shlex.quote(actual_cwd)

        script = (
            'printf "%s\\n" "$HOME"; '
            f'cd -- {target_cwd_expr} && pwd && '
            'uname -srm && '
            '(command -v rg >/dev/null 2>&1 && echo 1 || echo 0)'
        )
        rc, out, err = self._run_ssh_text(actual_host, script, timeout=25)
        if rc != 0:
            raise RuntimeError(
                f"Failed to connect to '{actual_host}' or enter directory (exit {rc}): {err.strip() or out.strip()}"
            )

        lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
        if len(lines) < 4:
            raise RuntimeError(f"Unexpected probe output from '{actual_host}': {out!r}")

        remote_home, resolved_cwd, uname_info, rg_flag = lines[0], lines[1], lines[2], lines[3]
        has_rg = rg_flag == "1"

        self.current_host = actual_host
        self.current_cwd = resolved_cwd
        self.current_alias = resolved_alias
        self.host_homes[actual_host] = remote_home
        self.host_has_rg[actual_host] = has_rg
        self._write_state_file()

        alias_line = f"Alias: {resolved_alias}\n" if resolved_alias else ""
        return (
            f"Connected to {actual_host}\n"
            f"{alias_line}"
            f"Remote CWD: {resolved_cwd}\n"
            f"Remote Home: {remote_home}\n"
            f"System: {uname_info}\n"
            f"ripgrep (rg) available: {'yes' if has_rg else 'no (using grep fallback)'}"
        )

    def status(self) -> str:
        if not self.current_host:
            return "Status: disconnected (no active SSH host)."

        check_cmd = _base_ssh_args() + ["-O", "check", self.current_host]
        proc = subprocess.run(
            check_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
        )
        cm_msg = (proc.stderr or proc.stdout).decode("utf-8", errors="replace").strip()
        alive = proc.returncode == 0
        alias_line = f"Alias: {self.current_alias}\n" if self.current_alias else ""
        return (
            f"Status: connected\n"
            f"{alias_line}"
            f"Host: {self.current_host}\n"
            f"Remote CWD: {self.current_cwd or '(unknown)'}\n"
            f"ControlMaster: {'active' if alive else 'inactive'} ({cm_msg})"
        )

    def disconnect(self, host: Optional[str] = None) -> str:
        target = (host or "").strip() or self.current_host
        if not target:
            return "No active SSH host to disconnect."

        exit_cmd = _base_ssh_args() + ["-O", "exit", target]
        proc = subprocess.run(
            exit_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
            check=False,
        )
        msg = (proc.stderr or proc.stdout).decode("utf-8", errors="replace").strip()
        cleared = False
        if target == self.current_host:
            self.current_host = None
            self.current_cwd = None
            self.current_alias = None
            cleared = True
        self.host_homes.pop(target, None)
        self.host_has_rg.pop(target, None)
        if cleared:
            self._clear_state_file()

        state_note = " Session state cleared." if cleared else ""
        if proc.returncode == 0:
            return f"Disconnected ControlMaster for '{target}'.{state_note}"
        return f"ControlMaster exit for '{target}' returned {proc.returncode} ({msg}).{state_note}"

    def exec_cmd(
        self,
        command: str,
        cwd: Optional[str] = None,
        host: Optional[str] = None,
        timeout: int = DEFAULT_EXEC_TIMEOUT,
    ) -> str:
        if not command or not command.strip():
            raise ValueError("'command' is required.")
        target_host = self._target_host(host)
        if target_host not in self.host_homes:
            self._ensure_home_and_rg(target_host)
        target_cwd = self._target_cwd(target_host, cwd)
        eff_timeout = max(1, min(int(timeout or DEFAULT_EXEC_TIMEOUT), MAX_EXEC_TIMEOUT))

        cwd_q = self._remote_quote_path(target_cwd)
        remote_script = f"cd -- {cwd_q} && {{\n{command}\n}}"
        rc, stdout, stderr = self._run_ssh_text(
            target_host,
            f"sh -c {shlex.quote(remote_script)}",
            timeout=eff_timeout,
        )
        out_t, _ = _truncate_text(stdout, MAX_EXEC_OUTPUT_CHARS)
        err_t, _ = _truncate_text(stderr, MAX_EXEC_OUTPUT_CHARS)
        parts = [f"Host: {target_host}", f"CWD: {target_cwd}", f"Exit code: {rc}"]
        if out_t:
            parts.append(f"--- STDOUT ---\n{out_t.rstrip()}")
        if err_t:
            parts.append(f"--- STDERR ---\n{err_t.rstrip()}")
        if not out_t and not err_t:
            parts.append("(no output)")
        return "\n".join(parts)

    def list_dir(
        self,
        path: str = ".",
        max_depth: int = 2,
        show_hidden: bool = False,
        host: Optional[str] = None,
    ) -> str:
        target_host = self._target_host(host)
        if target_host not in self.host_homes:
            self._ensure_home_and_rg(target_host)
        resolved = _resolve_remote_path(
            path, self._target_cwd(target_host), self.host_homes.get(target_host)
        )
        depth = max(1, min(int(max_depth or 2), 5))
        path_q = self._remote_quote_path(resolved)

        prune_expr = ""
        if depth > 1:
            prune_names = " -o ".join(f"-name {shlex.quote(d)}" for d in PRUNE_DIRS)
            prune_expr = f"\\( -type d \\( {prune_names} \\) -prune \\) -o "

        hidden_filter = "" if show_hidden else "! -name '.*' "
        # Print directories with trailing / using find + -exec test -d or -printf fallback.
        # POSIX-portable way: use find with -maxdepth and mark dirs in a small sh loop.
        script = (
            f"if [ ! -d {path_q} ]; then echo 'Not a directory: '\"{resolved}\" >&2; exit 1; fi; "
            f"find {path_q} -maxdepth {depth} -mindepth 1 {prune_expr}"
            f"\\( {hidden_filter}-print \\) 2>/dev/null | head -n {MAX_LIST_ENTRIES + 1} | "
            f"while IFS= read -r p; do [ -d \"$p\" ] && printf '%s/\\n' \"$p\" || printf '%s\\n' \"$p\"; done"
        )
        rc, stdout, stderr = self._run_ssh_text(target_host, script, timeout=30)
        if rc != 0:
            raise RuntimeError(f"Failed to list '{resolved}' on '{target_host}': {stderr.strip()}")

        lines = sorted(ln for ln in stdout.splitlines() if ln)
        truncated = len(lines) > MAX_LIST_ENTRIES
        if truncated:
            lines = lines[:MAX_LIST_ENTRIES]

        header = f"Directory: {resolved} (host={target_host}, entries={len(lines)}{', truncated' if truncated else ''})"
        if not lines:
            return f"{header}\n(empty)"
        return header + "\n" + "\n".join(lines)

    def read_file(
        self,
        path: str,
        start_line: int = 1,
        end_line: Optional[int] = None,
        host: Optional[str] = None,
    ) -> str:
        if not path or not path.strip():
            raise ValueError("'path' is required.")
        target_host = self._target_host(host)
        if target_host not in self.host_homes:
            self._ensure_home_and_rg(target_host)
        resolved = _resolve_remote_path(
            path, self._target_cwd(target_host), self.host_homes.get(target_host)
        )
        path_q = self._remote_quote_path(resolved)

        start = max(1, int(start_line or 1))
        if end_line is not None:
            end = max(start, int(end_line))
            req_end = min(end, start + MAX_READ_LINES - 1)
        else:
            req_end = start + MAX_READ_LINES - 1

        script = (
            f"if [ ! -f {path_q} ]; then echo 'File not found: '\"{resolved}\" >&2; exit 1; fi; "
            f"wc -l < {path_q}; "
            f"sed -n '{start},{req_end}p' {path_q}"
        )
        rc, stdout, stderr = self._run_ssh_text(target_host, script, timeout=30)
        if rc != 0:
            raise RuntimeError(f"Failed to read '{resolved}' on '{target_host}': {stderr.strip()}")

        raw_lines = stdout.splitlines(keepends=True)
        if not raw_lines:
            raise RuntimeError(f"Unexpected empty response reading '{resolved}'.")

        try:
            total_lines = int(raw_lines[0].strip())
        except ValueError as exc:
            raise RuntimeError(f"Failed to parse line count for '{resolved}': {raw_lines[0]!r}") from exc

        content_lines = raw_lines[1:]
        if total_lines == 0:
            return f"File: {resolved} (0 lines, empty)"
        if start > total_lines:
            return f"File: {resolved} ({total_lines} lines): requested start_line {start} is past EOF."

        rendered_lines: list[str] = []
        byte_count = 0
        byte_truncated = False
        last_shown = start - 1
        for offset, line in enumerate(content_lines):
            line_no = start + offset
            formatted = f"{line_no}: {line.rstrip(chr(10))}"
            encoded_len = len(formatted.encode("utf-8")) + 1
            if byte_count + encoded_len > MAX_READ_BYTES and rendered_lines:
                byte_truncated = True
                break
            rendered_lines.append(formatted)
            byte_count += encoded_len
            last_shown = line_no

        line_cap_hit = (end_line is None or end_line > req_end) and req_end < total_lines
        notes: list[str] = []
        if byte_truncated:
            notes.append(f"truncated at {MAX_READ_BYTES} bytes")
        if line_cap_hit:
            notes.append(f"capped at {MAX_READ_LINES} lines")
        if last_shown < total_lines:
            notes.append(f"next start_line={last_shown + 1}")
        note_str = f" [{', '.join(notes)}]" if notes else ""

        header = f"File: {resolved} (showing lines {start}-{last_shown} of {total_lines}){note_str}"
        return header + "\n" + "\n".join(rendered_lines)

    def write_file(
        self,
        path: str,
        content: str,
        append: bool = False,
        create_dirs: bool = True,
        host: Optional[str] = None,
    ) -> str:
        if not path or not path.strip():
            raise ValueError("'path' is required.")
        if content is None:
            raise ValueError("'content' is required.")
        target_host = self._target_host(host)
        if target_host not in self.host_homes:
            self._ensure_home_and_rg(target_host)
        resolved = _resolve_remote_path(
            path, self._target_cwd(target_host), self.host_homes.get(target_host)
        )
        path_q = self._remote_quote_path(resolved)

        mkdir_part = f'mkdir -p -- "$(dirname -- {path_q})" && ' if create_dirs else ""
        redir = ">>" if append else ">"
        script = f"{mkdir_part}cat {redir} {path_q}"
        rc, _, stderr = self._run_ssh_text(target_host, script, stdin_text=content, timeout=30)
        if rc != 0:
            raise RuntimeError(f"Failed to write '{resolved}' on '{target_host}': {stderr.strip()}")

        byte_len = len(content.encode("utf-8"))
        action = "Appended" if append else "Wrote"
        return f"{action} {byte_len} bytes to {resolved} on {target_host}."

    def edit_file(
        self,
        path: str,
        target: str,
        replacement: str,
        replace_all: bool = False,
        host: Optional[str] = None,
    ) -> str:
        if not path or not path.strip():
            raise ValueError("'path' is required.")
        if target is None or target == "":
            raise ValueError("'target' must be a non-empty string.")
        if replacement is None:
            raise ValueError("'replacement' is required.")

        target_host = self._target_host(host)
        if target_host not in self.host_homes:
            self._ensure_home_and_rg(target_host)
        resolved = _resolve_remote_path(
            path, self._target_cwd(target_host), self.host_homes.get(target_host)
        )
        path_q = self._remote_quote_path(resolved)

        read_script = f"if [ ! -f {path_q} ]; then echo 'File not found: '\"{resolved}\" >&2; exit 1; fi; cat -- {path_q}"
        rc, original, stderr = self._run_ssh_text(target_host, read_script, timeout=30)
        if rc != 0:
            raise RuntimeError(f"Failed to read '{resolved}' on '{target_host}': {stderr.strip()}")

        count = original.count(target)
        if count == 0:
            raise ValueError(f"Target string not found in '{resolved}'.")
        if count > 1 and not replace_all:
            raise ValueError(
                f"Target string matched {count} times in '{resolved}'. "
                "Provide more context in 'target' or set replace_all=true."
            )

        updated = original.replace(target, replacement) if replace_all else original.replace(target, replacement, 1)
        replaced_count = count if replace_all else 1

        write_script = (
            f"p={path_q}; "
            'tmp="${p}.agy_tmp.$$"; '
            'cp -p -- "$p" "$tmp" 2>/dev/null || true; '
            'cat > "$tmp" && mv -f -- "$tmp" "$p"'
        )
        rc_w, _, err_w = self._run_ssh_text(target_host, write_script, stdin_text=updated, timeout=30)
        if rc_w != 0:
            raise RuntimeError(f"Failed to write edited '{resolved}' on '{target_host}': {err_w.strip()}")

        diff_lines = list(
            difflib.unified_diff(
                original.splitlines(),
                updated.splitlines(),
                fromfile=f"a/{resolved}",
                tofile=f"b/{resolved}",
                lineterm="",
                n=3,
            )
        )
        diff_text = "\n".join(diff_lines[:200])
        if len(diff_lines) > 200:
            diff_text += f"\n...[diff truncated, {len(diff_lines)} lines total]"
        return f"Edited {resolved} on {target_host} ({replaced_count} replacement(s)):\n{diff_text}"

    def search(
        self,
        query: str,
        path: str = ".",
        glob_pattern: Optional[str] = None,
        is_regex: bool = False,
        case_sensitive: bool = True,
        max_results: int = DEFAULT_SEARCH_RESULTS,
        host: Optional[str] = None,
    ) -> str:
        if not query:
            raise ValueError("'query' is required.")
        target_host = self._target_host(host)
        _, has_rg = self._ensure_home_and_rg(target_host)
        resolved = _resolve_remote_path(
            path, self._target_cwd(target_host), self.host_homes.get(target_host)
        )
        path_q = self._remote_quote_path(resolved)
        limit = max(1, min(int(max_results or DEFAULT_SEARCH_RESULTS), MAX_SEARCH_RESULTS))

        if has_rg:
            args = ["rg", "--line-number", "--no-heading", "--color=never"]
            if not is_regex:
                args.append("-F")
            if not case_sensitive:
                args.append("-i")
            if glob_pattern:
                args.extend(["-g", glob_pattern])
            args.extend(["--", query])
            cmd_prefix = " ".join(shlex.quote(a) for a in args) + f" {path_q}"
        else:
            args = ["grep", "-rn", "--binary-files=without-match"]
            for d in PRUNE_DIRS:
                args.append(f"--exclude-dir={d}")
            if not is_regex:
                args.append("-F")
            if not case_sensitive:
                args.append("-i")
            if glob_pattern:
                args.append(f"--include={glob_pattern}")
            args.extend(["--", query])
            cmd_prefix = " ".join(shlex.quote(a) for a in args) + f" {path_q}"

        script = f"{cmd_prefix} | head -n {limit + 1}"
        rc, stdout, stderr = self._run_ssh_text(target_host, script, timeout=45)
        # Note: head exits 0; if grep/rg has no matches, stdout is empty.
        if rc != 0 and not stdout and stderr.strip():
            raise RuntimeError(f"Search failed on '{target_host}': {stderr.strip()}")

        lines = stdout.splitlines()
        truncated = len(lines) > limit
        if truncated:
            lines = lines[:limit]
        if not lines:
            return f"No matches for {query!r} in {resolved} on {target_host}."
        header = f"Search matches for {query!r} in {resolved} (showing {len(lines)}{', truncated' if truncated else ''}):"
        return header + "\n" + "\n".join(lines)


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "ssh_list_hosts",
        "description": "List configured workspace aliases (~/.config/ssh-workspace/aliases.json) and SSH host aliases from ~/.ssh/config.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_set_alias",
        "description": "Create or update a persistent SSH workspace alias mapping a short name to a host and remote cwd.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Short alias name (no whitespace, e.g. 'my-project').",
                },
                "host": {
                    "type": "string",
                    "description": "SSH host alias from ~/.ssh/config or user@hostname.",
                },
                "cwd": {
                    "type": "string",
                    "description": "Default remote working directory for this alias.",
                },
            },
            "required": ["name", "host", "cwd"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_remove_alias",
        "description": "Remove a persistent SSH workspace alias from ~/.config/ssh-workspace/aliases.json.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Workspace alias name to remove.",
                }
            },
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_connect",
        "description": "Connect to an SSH workspace alias (~/.config/ssh-workspace/aliases.json), an ~/.ssh/config host, user@hostname, or host:/remote/path using ControlMaster multiplexing.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "host": {
                    "type": "string",
                    "description": "Workspace alias from ~/.config/ssh-workspace/aliases.json, SSH host alias from ~/.ssh/config, user@hostname, or host:/remote/path.",
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional remote working directory override (defaults to alias cwd or remote $HOME).",
                },
            },
            "required": ["host"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_status",
        "description": "Show the active SSH host, remote working directory, and ControlMaster connection status.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_disconnect",
        "description": "Close the ControlMaster connection for the specified or active SSH host and clear session state.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "host": {
                    "type": "string",
                    "description": "Optional SSH host to disconnect (defaults to the active host).",
                }
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_exec",
        "description": "Execute a shell command in the remote working directory over SSH.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to execute on the remote host.",
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional remote directory for this command (defaults to active remote cwd).",
                },
                "host": {
                    "type": "string",
                    "description": "Optional SSH host override.",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in seconds (default 60, max 600).",
                },
            },
            "required": ["command"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_list_dir",
        "description": "List files and directories in a remote path over SSH.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Remote path to list (default '.').",
                },
                "max_depth": {
                    "type": "integer",
                    "description": "Maximum directory traversal depth from 1 to 5 (default 2).",
                },
                "show_hidden": {
                    "type": "boolean",
                    "description": "Include dotfiles/directories (default false).",
                },
                "host": {
                    "type": "string",
                    "description": "Optional SSH host override.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_read_file",
        "description": "Read lines from a remote file with 1-based line numbers (capped at 800 lines or 45000 bytes per call).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Remote file path (absolute or relative to active remote cwd).",
                },
                "start_line": {
                    "type": "integer",
                    "description": "1-based start line (default 1).",
                },
                "end_line": {
                    "type": "integer",
                    "description": "Optional 1-based end line (inclusive).",
                },
                "host": {
                    "type": "string",
                    "description": "Optional SSH host override.",
                },
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_write_file",
        "description": "Write or append UTF-8 content to a remote file over SSH.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Remote file path.",
                },
                "content": {
                    "type": "string",
                    "description": "UTF-8 text content to write.",
                },
                "append": {
                    "type": "boolean",
                    "description": "Append to the end of the file instead of overwriting (default false).",
                },
                "create_dirs": {
                    "type": "boolean",
                    "description": "Create parent directories if missing (default true).",
                },
                "host": {
                    "type": "string",
                    "description": "Optional SSH host override.",
                },
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_edit_file",
        "description": "Perform an exact string replacement on a remote file and return a unified diff.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Remote file path.",
                },
                "target": {
                    "type": "string",
                    "description": "Exact existing text to replace.",
                },
                "replacement": {
                    "type": "string",
                    "description": "Replacement text.",
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "Replace all occurrences instead of requiring a unique match (default false).",
                },
                "host": {
                    "type": "string",
                    "description": "Optional SSH host override.",
                },
            },
            "required": ["path", "target", "replacement"],
            "additionalProperties": False,
        },
    },
    {
        "name": "ssh_search",
        "description": "Search remote files using ripgrep (rg) if available or grep -rn fallback.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search pattern or literal string.",
                },
                "path": {
                    "type": "string",
                    "description": "Remote directory or file path to search (default '.').",
                },
                "glob": {
                    "type": "string",
                    "description": "Optional file glob filter (e.g., '*.py').",
                },
                "is_regex": {
                    "type": "boolean",
                    "description": "Treat query as a regex instead of literal text (default false).",
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "Whether search is case-sensitive (default true).",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum matching lines to return (default 100, max 500).",
                },
                "host": {
                    "type": "string",
                    "description": "Optional SSH host override.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
]


def _dispatch_tool(
    state: SshSessionState, name: str, args: dict[str, Any]
) -> tuple[str, bool]:
    """Execute a tool by name and return (text, is_error)."""
    handlers: dict[str, Callable[[], str]] = {
        "ssh_list_hosts": lambda: state.list_hosts(),
        "ssh_set_alias": lambda: state.set_alias(
            args.get("name", ""), args.get("host", ""), args.get("cwd", "")
        ),
        "ssh_remove_alias": lambda: state.remove_alias(args.get("name", "")),
        "ssh_connect": lambda: state.connect(args.get("host", ""), args.get("cwd")),
        "ssh_status": lambda: state.status(),
        "ssh_disconnect": lambda: state.disconnect(args.get("host")),
        "ssh_exec": lambda: state.exec_cmd(
            args.get("command", ""),
            args.get("cwd"),
            args.get("host"),
            args.get("timeout", DEFAULT_EXEC_TIMEOUT),
        ),
        "ssh_list_dir": lambda: state.list_dir(
            args.get("path", "."),
            args.get("max_depth", 2),
            bool(args.get("show_hidden", False)),
            args.get("host"),
        ),
        "ssh_read_file": lambda: state.read_file(
            args.get("path", ""),
            args.get("start_line", 1),
            args.get("end_line"),
            args.get("host"),
        ),
        "ssh_write_file": lambda: state.write_file(
            args.get("path", ""),
            args.get("content"),
            bool(args.get("append", False)),
            bool(args.get("create_dirs", True)),
            args.get("host"),
        ),
        "ssh_edit_file": lambda: state.edit_file(
            args.get("path", ""),
            args.get("target", ""),
            args.get("replacement"),
            bool(args.get("replace_all", False)),
            args.get("host"),
        ),
        "ssh_search": lambda: state.search(
            args.get("query", ""),
            args.get("path", "."),
            args.get("glob"),
            bool(args.get("is_regex", False)),
            bool(args.get("case_sensitive", True)),
            args.get("max_results", DEFAULT_SEARCH_RESULTS),
            args.get("host"),
        ),
    }

    handler = handlers.get(name)
    if handler is None:
        return f"Unknown tool: {name}", True
    try:
        return handler(), False
    except Exception as exc:  # noqa: BLE001
        return f"Error: {exc}", True


def _write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def _handle_request(state: SshSessionState, msg: dict[str, Any]) -> Optional[dict[str, Any]]:
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    # Notifications have no 'id' and expect no response.
    if msg_id is None:
        return None

    if method == "initialize":
        proto = params.get("protocolVersion") or DEFAULT_PROTOCOL_VERSION
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": proto,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        }

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {"tools": TOOL_DEFINITIONS},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": "Error: tool arguments must be a JSON object."}],
                    "isError": True,
                },
            }
        text, is_error = _dispatch_tool(state, tool_name, arguments)
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "content": [{"type": "text", "text": text}],
                "isError": is_error,
            },
        }

    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> int:
    state = SshSessionState()
    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                _write_response(
                    {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32700, "message": f"Parse error: {exc}"},
                    }
                )
                continue

            if not isinstance(msg, dict):
                continue

            resp = _handle_request(state, msg)
            if resp is not None:
                _write_response(resp)
    finally:
        state._clear_state_file()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
