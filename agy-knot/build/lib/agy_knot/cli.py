"""agy-knot 命令行入口。"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from agy_knot import __version__
from agy_knot.agy_runner import AgyRunOptions, build_event_prompt, run_agy_turn
from agy_knot.config import ConfigError, resolve_auth, resolve_state_dir
from agy_knot.session import create_remote_session
from agy_knot.store import BridgeState, InstanceLock, LockConflictError, StateStore
from agy_knot.ws_client import KnotBridge


def _ensure_session_bound(
    *,
    store: StateStore,
    state: BridgeState,
    rest_url: str,
    token_auth: object,
    session_name: str,
) -> bool:
    """确保 state 已绑定 Knot agent_session_id；未绑定时按 pi-knot 语义安全创建。"""
    from agy_knot.config import KnotAuth

    assert isinstance(token_auth, KnotAuth)
    if state.agent_session_id is not None:
        if state.rest_url and state.rest_url != rest_url:
            print(
                f'当前状态目录绑定的是 {state.rest_url}（会话 {state.agent_session_id}），'
                f'与当前目标地址 {rest_url} 不一致；请使用独立的 --profile。',
                file=sys.stderr,
            )
            return False
        if not state.rest_url:
            state.rest_url = rest_url
            store.save_state(state)
        return True

    if state.create_pending:
        print(
            '上次创建 Knot 会话的结果未知（create_pending=true），为避免重复创建身份已停止自动创建。\n'
            '请先在 Knot 确认是否已有对应会话：\n'
            '  - 若已创建：运行 `agy-knot connect <session_id>` 绑定；\n'
            '  - 若确认未创建：运行 `agy-knot reset-pending` 后重试。',
            file=sys.stderr,
        )
        return False

    # 先持久化 pending 再发请求，防止进程崩溃导致重复创建
    state.rest_url = rest_url
    state.create_pending = True
    store.save_state(state)

    result = create_remote_session(token_auth, session_name)
    if result.ok and result.session_id is not None:
        state.agent_session_id = result.session_id
        state.agent_session_name = result.session_name or session_name
        state.create_pending = False
        store.save_state(state)
        print(
            f'已自动创建并绑定 Knot 会话：id={state.agent_session_id} name={state.agent_session_name!r}\n'
            '提示：新建会话尚未加入任何 Room，请在 agy 中使用 Knot MCP 的 join_room 加入目标 Room。',
            file=sys.stderr,
        )
        return True

    if result.certain:
        state.create_pending = False
        store.save_state(state)
    print(result.reason, file=sys.stderr)
    return False


def _cmd_run(args: argparse.Namespace) -> int:
    try:
        auth = resolve_auth(rest_url_override=args.url, server_name=args.mcp_server)
    except ConfigError as exc:
        print(f'配置错误：{exc}', file=sys.stderr)
        return 2

    state_dir = resolve_state_dir(profile=args.profile, state_dir_override=args.state_dir)
    store = StateStore(state_dir)

    try:
        lock = InstanceLock(store.lock_path)
        lock.acquire()
    except LockConflictError as exc:
        print(str(exc), file=sys.stderr)
        return 5

    try:
        state = store.load_state()
        if args.conversation:
            state.agy_conversation_id = args.conversation.strip()
            store.save_state(state)

        default_name = f'agy-{socket.gethostname().split(".")[0]}-{args.profile}'
        session_name = (args.session_name or default_name).strip()
        if not _ensure_session_bound(
            store=store,
            state=state,
            rest_url=auth.rest_url,
            token_auth=auth,
            session_name=session_name,
        ):
            return 2

        agy_options = AgyRunOptions(
            agy_bin=args.agy_bin,
            cwd=Path(args.cwd).expanduser().resolve() if args.cwd else Path.cwd(),
            mode=args.mode,
            sandbox=not args.no_sandbox,
            model=args.model or '',
            effort=args.effort or '',
            print_timeout=args.print_timeout,
            mcp_server=args.mcp_server,
            allow_knot_mcp=not args.no_allow_knot_mcp,
            dangerously_skip_permissions=args.dangerously_skip_permissions,
        )

        bridge = KnotBridge(
            auth=auth,
            store=store,
            state=state,
            auto_execute=args.auto_execute,
            agy_options=agy_options,
        )

        async def _runner() -> int:
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    loop.add_signal_handler(sig, bridge.request_stop)
                except NotImplementedError:
                    pass
            return await bridge.run()

        return asyncio.run(_runner())
    finally:
        lock.release()


def _cmd_connect(args: argparse.Namespace) -> int:
    state_dir = resolve_state_dir(profile=args.profile, state_dir_override=args.state_dir)
    store = StateStore(state_dir)
    with InstanceLock(store.lock_path):
        state = store.load_state()
        if args.url:
            from agy_knot.config import normalize_rest_url

            state.rest_url = normalize_rest_url(args.url)
        state.agent_session_id = args.session_id
        if args.session_name:
            state.agent_session_name = args.session_name
        if args.conversation is not None:
            state.agy_conversation_id = args.conversation.strip()
        state.create_pending = False
        store.save_state(state)
    print(
        f'已绑定 profile={args.profile} -> agent_session_id={state.agent_session_id} '
        f'(agy_conversation_id={state.agy_conversation_id or "<未绑定>"})'
    )
    return 0


def _cmd_reset_pending(args: argparse.Namespace) -> int:
    state_dir = resolve_state_dir(profile=args.profile, state_dir_override=args.state_dir)
    store = StateStore(state_dir)
    with InstanceLock(store.lock_path):
        state = store.load_state()
        state.create_pending = False
        store.save_state(state)
    print(f'已清除 {store.state_path} 中的 create_pending 标记。')
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    state_dir = resolve_state_dir(profile=args.profile, state_dir_override=args.state_dir)
    store = StateStore(state_dir)
    state = store.load_state()
    inbox = store.read_inbox()
    counts: dict[str, int] = {}
    for info in state.deliveries.values():
        st = str(info.get('status', 'unknown'))
        counts[st] = counts.get(st, 0) + 1

    print(f'profile:             {args.profile}')
    print(f'state_dir:           {state_dir}')
    print(f'rest_url:            {state.rest_url or "<未初始化>"}')
    print(f'agent_session_id:    {state.agent_session_id if state.agent_session_id is not None else "<未绑定>"}')
    print(f'agent_session_name:  {state.agent_session_name or "-"}')
    print(f'create_pending:      {state.create_pending}')
    print(f'agy_conversation_id: {state.agy_conversation_id or "<首次执行时自动绑定>"}')
    print(f'cursor:              {state.cursor}')
    print(f'auto_execute_armed:  {state.auto_execute_armed} (baseline={state.arm_baseline_event_id})')
    print(f'inbox_count:         {len(inbox)}')
    print(f'deliveries:          {counts or "{}"}')
    return 0


def _cmd_inbox(args: argparse.Namespace) -> int:
    state_dir = resolve_state_dir(profile=args.profile, state_dir_override=args.state_dir)
    store = StateStore(state_dir)
    state = store.load_state()
    items = store.read_inbox()
    if not items:
        print('收件箱为空。')
        return 0
    for item in items[-args.limit :]:
        eid = item.get('event_id')
        delivery = state.deliveries.get(str(eid), {}).get('status', '-')
        raw_sender = item.get('sender')
        sender = raw_sender if isinstance(raw_sender, dict) else {}
        print(
            f"event={eid:<6} {item.get('type', '')!s:16} delivery={delivery:8} "
            f"room={item.get('room_id')} msg={item.get('message_id')} #{item.get('seq')} "
            f"from={sender.get('kind', '')}:{sender.get('id', '')} summary={item.get('summary', '')!r}"
        )
    return 0


def _cmd_trigger(args: argparse.Namespace) -> int:
    state_dir = resolve_state_dir(profile=args.profile, state_dir_override=args.state_dir)
    store = StateStore(state_dir)
    state = store.load_state()
    if state.agent_session_id is None:
        print('尚未绑定 agent_session_id，请先运行 `agy-knot run` 或 `agy-knot connect <id>`。', file=sys.stderr)
        return 2

    event = store.find_inbox_event(args.event_id)
    if event is None:
        print(f'收件箱中未找到 event_id={args.event_id}。', file=sys.stderr)
        return 1

    # 默认：只有 mention.execute 才按执行触发，普通消息默认按只读总结触发
    read_only = args.read_only or (event.get('type') != 'mention.execute' and not args.force_execute)
    prompt = build_event_prompt(agent_session_id=state.agent_session_id, event=event, read_only=read_only)
    agy_options = AgyRunOptions(
        agy_bin=args.agy_bin,
        cwd=Path(args.cwd).expanduser().resolve() if args.cwd else Path.cwd(),
        mode=args.mode,
        sandbox=not args.no_sandbox,
        model=args.model or '',
        effort=args.effort or '',
        print_timeout=args.print_timeout,
        mcp_server=args.mcp_server,
        allow_knot_mcp=not args.no_allow_knot_mcp,
        dangerously_skip_permissions=args.dangerously_skip_permissions,
    )

    result = asyncio.run(
        run_agy_turn(
            prompt=prompt,
            options=agy_options,
            conversation_id=args.conversation or state.agy_conversation_id,
            read_only=read_only,
        )
    )
    if result.conversation_id and not state.agy_conversation_id:
        state.agy_conversation_id = result.conversation_id
    state.deliveries[str(args.event_id)] = {
        'status': 'done' if result.ok else 'failed',
        'agy_status': result.status,
        'updated_at': int(time.time()),
        'error': result.error or '',
    }
    store.save_state(state)

    if result.response:
        print(result.response)
    if not result.ok:
        print(f'agy 执行失败（status={result.status}）：{result.error}', file=sys.stderr)
        return 1
    return 0


def _cmd_session_start_hook(args: argparse.Namespace) -> int:
    """供 Antigravity SessionStart hook 调用：若后台未运行则静默拉起 agy-knot run。"""
    if os.environ.get('AGY_KNOT_CHILD') == '1':
        return 0

    cwd = Path(args.cwd).expanduser().resolve() if args.cwd else None
    if cwd is None and not sys.stdin.isatty():
        try:
            payload = json.loads(sys.stdin.read() or '{}')
            if isinstance(payload, dict):
                workspaces = payload.get('workspacePaths')
                if isinstance(workspaces, list) and workspaces and isinstance(workspaces[0], str):
                    cwd = Path(workspaces[0]).expanduser().resolve()
        except json.JSONDecodeError:
            pass
    if cwd is None:
        cwd = Path.cwd()

    state_dir = resolve_state_dir(profile=args.profile, state_dir_override=args.state_dir)
    store = StateStore(state_dir)

    # 非阻塞探测锁：若已有实例运行则直接跳过，不重复拉起
    probe_lock = InstanceLock(store.lock_path)
    try:
        probe_lock.acquire()
    except LockConflictError:
        return 0
    probe_lock.release()

    agy_knot_bin = shutil.which('agy-knot') or sys.argv[0]
    cmd = [agy_knot_bin, 'run', '--profile', args.profile, '--cwd', str(cwd)]
    if args.state_dir:
        cmd.extend(['--state-dir', args.state_dir])
    if args.auto_execute:
        cmd.append('--auto-execute')
    if args.no_sandbox:
        cmd.append('--no-sandbox')
    if args.mode != 'auto':
        cmd.extend(['--mode', args.mode])

    state_dir.mkdir(parents=True, exist_ok=True)
    log_path = state_dir / 'daemon.log'
    with log_path.open('a', encoding='utf-8') as log_fp:
        subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=log_fp,
            stderr=log_fp,
            start_new_session=True,
            close_fds=True,
        )
    return 0


def _cmd_install_hook(args: argparse.Namespace) -> int:
    """将 SessionStart hook 安全合并写入 ~/.gemini/config/hooks.json（保留已有其他 hook）。"""
    hooks_path = Path(args.hooks_file).expanduser()
    hooks_data: dict[str, object] = {}
    if hooks_path.is_file():
        raw = json.loads(hooks_path.read_text(encoding='utf-8'))
        if not isinstance(raw, dict):
            print(f'hooks 文件根节点不是 JSON 对象：{hooks_path}', file=sys.stderr)
            return 2
        hooks_data = raw

    agy_knot_bin = shutil.which('agy-knot') or str(Path.home() / '.local' / 'bin' / 'agy-knot')
    cmd_parts = [agy_knot_bin, 'session-start-hook', '--profile', args.profile]
    if args.state_dir:
        cmd_parts.extend(['--state-dir', args.state_dir])
    if args.auto_execute:
        cmd_parts.append('--auto-execute')
    if args.no_sandbox:
        cmd_parts.append('--no-sandbox')
    if args.mode != 'auto':
        cmd_parts.extend(['--mode', args.mode])

    hooks_data['agy-knot'] = {
        'SessionStart': [
            {
                'type': 'command',
                'command': shlex.join(cmd_parts),
                'timeout': 10,
            }
        ]
    }

    hooks_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=hooks_path.parent, prefix='.hooks-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fp:
            json.dump(hooks_data, fp, ensure_ascii=False, indent=2)
            fp.write('\n')
        os.replace(tmp_name, hooks_path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

    print(f'已写入 SessionStart hook 到 {hooks_path}（profile={args.profile} auto_execute={args.auto_execute}）')
    return 0


def _add_common_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--profile', default='default', help='配置 profile 名（用于区分不同工作区/会话，默认 default）')
    parser.add_argument('--state-dir', default=None, help='覆盖状态目录（默认 ~/.knot/agy-knot/<profile>）')


def _add_agy_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--cwd', default=None, help='拉起 agy 时的工作目录（默认当前目录）')
    parser.add_argument('--conversation', default='', help='指定或绑定 agy conversation ID')
    parser.add_argument('--agy-bin', default='agy', help='agy 可执行文件路径（默认 agy）')
    parser.add_argument('--mode', default='auto', choices=('auto', 'accept-edits', 'plan'), help='agy 执行模式（默认 auto）')
    parser.add_argument('--no-sandbox', action='store_true', help='关闭 agy 终端沙盒（默认开启 --sandbox）')
    parser.add_argument('--model', default='', help='覆盖 agy 模型')
    parser.add_argument('--effort', default='', help='覆盖 agy 推理强度（low|medium|high|xhigh|max）')
    parser.add_argument('--print-timeout', default='10m', help='单次 agy 执行超时（默认 10m）')
    parser.add_argument('--mcp-server', default='knot', help='mcp_config.json 中的 server 名称（默认 knot）')
    parser.add_argument(
        '--no-allow-knot-mcp',
        action='store_true',
        help='不通过 --settings 自动放行 Knot MCP 工具白名单（完全交由全局 settings.json 控制）',
    )
    parser.add_argument(
        '--dangerously-skip-permissions',
        action='store_true',
        help='高危：跳过 agy 全部工具权限检查（默认关闭）',
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='agy-knot',
        description='Antigravity CLI (agy) 的 Knot Agent Session WS 实时订阅与执行桥接',
    )
    parser.add_argument('-V', '--version', action='version', version=f'agy-knot {__version__}')
    sub = parser.add_subparsers(dest='command', required=True)

    p_run = sub.add_parser('run', help='连接 Knot WS 并持续监听事件')
    _add_common_flags(p_run)
    _add_agy_flags(p_run)
    p_run.add_argument('--url', default=None, help='Knot 基址（默认从 KNOT_REST_URL 或 mcp_config.json 读取）')
    p_run.add_argument('--session-name', default=None, help='首次自动创建 Knot 会话时的名称')
    p_run.add_argument(
        '--auto-execute',
        action='store_true',
        help='开启后自动将结构化 mention.execute（基线之后）串行交由 agy 处理',
    )
    p_run.set_defaults(func=_cmd_run)

    p_connect = sub.add_parser('connect', help='显式绑定一个已有的 Knot agent_session_id')
    _add_common_flags(p_connect)
    p_connect.add_argument('session_id', type=int, help='已创建的 Knot agent_session_id')
    p_connect.add_argument('--session-name', default='', help='可选：记录会话名称')
    p_connect.add_argument('--url', default=None, help='可选：记录 Knot 基址')
    p_connect.add_argument('--conversation', default=None, help='可选：同时绑定 agy conversation ID')
    p_connect.set_defaults(func=_cmd_connect)

    p_reset = sub.add_parser('reset-pending', help='清除 create_pending 标记（仅在确认服务端未重复建会话后使用）')
    _add_common_flags(p_reset)
    p_reset.set_defaults(func=_cmd_reset_pending)

    p_status = sub.add_parser('status', help='查看当前 profile 绑定与游标状态')
    _add_common_flags(p_status)
    p_status.set_defaults(func=_cmd_status)

    p_inbox = sub.add_parser('inbox', help='查看本地收件箱事件索引')
    _add_common_flags(p_inbox)
    p_inbox.add_argument('--limit', type=int, default=20, help='显示最近 N 条事件（默认 20）')
    p_inbox.set_defaults(func=_cmd_inbox)

    p_trigger = sub.add_parser('trigger', help='手动把收件箱中的某条事件交给 agy 处理')
    _add_common_flags(p_trigger)
    _add_agy_flags(p_trigger)
    p_trigger.add_argument('event_id', type=int, help='要处理的事件 ID')
    p_trigger.add_argument('--read-only', action='store_true', help='仅让 agy 读取并总结，不执行也不回复')
    p_trigger.add_argument('--force-execute', action='store_true', help='对非 mention.execute 事件强制按执行提示触发')
    p_trigger.set_defaults(func=_cmd_trigger)

    p_hook = sub.add_parser('session-start-hook', help='供 Antigravity SessionStart hook 调用的后台自启入口')
    _add_common_flags(p_hook)
    p_hook.add_argument('--cwd', default=None, help='覆盖工作目录（默认取 hook stdin 的 workspacePaths[0]）')
    p_hook.add_argument('--auto-execute', action='store_true', help='后台拉起时开启 mention.execute 自动执行')
    p_hook.add_argument('--mode', default='auto', choices=('auto', 'accept-edits', 'plan'), help='agy 执行模式（默认 auto）')
    p_hook.add_argument('--no-sandbox', action='store_true', help='关闭 agy 终端沙盒')
    p_hook.set_defaults(func=_cmd_session_start_hook)

    p_install_hook = sub.add_parser('install-hook', help='将 SessionStart 自动拉起 hook 写入 ~/.gemini/config/hooks.json')
    _add_common_flags(p_install_hook)
    p_install_hook.add_argument(
        '--hooks-file',
        default=str(Path.home() / '.gemini' / 'config' / 'hooks.json'),
        help='hooks.json 路径（默认 ~/.gemini/config/hooks.json）',
    )
    p_install_hook.add_argument('--auto-execute', action='store_true', help='自启时开启 mention.execute 自动执行')
    p_install_hook.add_argument('--mode', default='auto', choices=('auto', 'accept-edits', 'plan'), help='agy 执行模式（默认 auto）')
    p_install_hook.add_argument('--no-sandbox', action='store_true', help='关闭 agy 终端沙盒')
    p_install_hook.set_defaults(func=_cmd_install_hook)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == '__main__':
    raise SystemExit(main())
