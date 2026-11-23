"""Knot Agent Session WebSocket 客户端、REST 游标补拉与 mention.execute 串行执行调度。"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import urllib.request
from typing import Any

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from agy_knot.agy_runner import AgyRunOptions, build_event_prompt, run_agy_turn
from agy_knot.config import KnotAuth, sanitize_display
from agy_knot.store import BridgeState, StateStore

BACKOFF_START = 1.0
BACKOFF_MAX = 30.0
BUFFER_LIMIT = 512


def fetch_events_page(auth: KnotAuth, session_id: int, after_id: int, limit: int = 100) -> dict[str, Any]:
    """拉取一页 /api/agent-events（在工作线程中调用，避免阻塞 WS 心跳）。"""
    url = f'{auth.rest_url}/api/agent-events?agent_session_id={session_id}&after_id={after_id}&limit={limit}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {auth.token}'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    if not isinstance(data, dict):
        raise ConnectionError('REST 补拉返回的 JSON 不是对象')
    return data


class KnotBridge:
    """维持单条 WS 连接，将事件写入收件箱，并在开启 auto_execute 时串行调用 agy。"""

    def __init__(
        self,
        *,
        auth: KnotAuth,
        store: StateStore,
        state: BridgeState,
        auto_execute: bool = False,
        agy_options: AgyRunOptions | None = None,
    ) -> None:
        self.auth = auth
        self.store = store
        self.state = state
        self.auto_execute = auto_execute
        self.agy_options = agy_options or AgyRunOptions()

        assert self.state.agent_session_id is not None
        self.session_id: int = self.state.agent_session_id
        self.ws_url = f'{auth.ws_base_url}/ws/agent-sessions/{self.session_id}'

        self._buffer: dict[int, dict[str, Any]] = {}
        self._catching_up = True
        self._ready = asyncio.Event()
        self._overflow = False
        self._state_lock = asyncio.Lock()

        self._exec_queue: asyncio.Queue[int] = asyncio.Queue()
        self._queued_ids: set[int] = set()
        self._stop_event = asyncio.Event()

    def request_stop(self) -> None:
        self._stop_event.set()

    def _enqueue_delivery(self, event_id: int) -> None:
        if not self.auto_execute or event_id in self._queued_ids:
            return
        self._queued_ids.add(event_id)
        self._exec_queue.put_nowait(event_id)

    def _warn_stale_running(self) -> None:
        stale = [eid for eid, info in self.state.deliveries.items() if info.get('status') == 'running']
        if stale:
            print(
                f'[警告] 发现上次中断残留的 running 投递事件 {stale}：为避免重复执行副作用，不会自动重发；'
                f'请确认后用 `agy-knot trigger <event_id>` 手动处理。',
                file=sys.stderr,
            )

    def _requeue_pending_deliveries(self) -> None:
        if not self.auto_execute:
            return
        pending_ids = sorted(
            int(eid)
            for eid, info in self.state.deliveries.items()
            if info.get('status') == 'pending'
        )
        for eid in pending_ids:
            self._enqueue_delivery(eid)

    async def _handle_event(self, event: dict[str, Any]) -> None:
        event_id = int(event['event_id'])
        async with self._state_lock:
            if event_id <= self.state.cursor:
                return
            try:
                record = self.store.append_inbox(event, self.auth.token)
            except ValueError as exc:
                print(f'[跳过事件 {event_id}] {exc}', file=sys.stderr)
                return

            self.state.cursor = event_id

            # 仅结构化 mention.execute 且晚于启用基线才进入自动执行队列
            should_execute = (
                self.auto_execute
                and self.state.auto_execute_armed
                and record['type'] == 'mention.execute'
                and event_id > self.state.arm_baseline_event_id
            )
            key = str(event_id)
            if should_execute and key not in self.state.deliveries:
                self.state.deliveries[key] = {
                    'status': 'pending',
                    'room_id': record['room_id'],
                    'message_id': record['message_id'],
                    'updated_at': int(time.time()),
                }
            self.store.save_state(self.state)

        sender = record['sender']
        print(
            f"{record['type']:16} event={event_id:<6} room={record['room_id']} "
            f"msg={record['message_id']} #{record['seq']} from={sender['kind']}:{sender['id']} "
            f"summary={record['summary']!r}",
            flush=True,
        )
        if should_execute:
            self._enqueue_delivery(event_id)

    async def _backfill(self) -> None:
        after_id = self.state.cursor
        while True:
            page = await asyncio.to_thread(fetch_events_page, self.auth, self.session_id, after_id)
            events = page.get('events', [])
            for event in events:
                await self._handle_event(event)
                after_id = max(after_id, int(event['event_id']))
            if not page.get('has_more') or not events:
                return

    async def _catch_up(self) -> None:
        await self._ready.wait()
        await self._backfill()
        while self._buffer:
            for event_id in sorted(self._buffer):
                event = self._buffer.pop(event_id)
                await self._handle_event(event)
        self._catching_up = False

    async def _offer_live(self, event: dict[str, Any]) -> None:
        event_id = int(event['event_id'])
        if event_id <= self.state.cursor:
            return
        if self._catching_up or self._buffer:
            if len(self._buffer) >= BUFFER_LIMIT:
                self._overflow = True
                raise ConnectionError('实时事件缓冲溢出，触发重连补拉')
            self._buffer[event_id] = event
            return
        await self._handle_event(event)

    async def _on_ready(self, message: dict[str, Any]) -> None:
        latest_id = int(message.get('latest_event_id') or 0)
        rooms = [r.get('id') for r in message.get('rooms', []) if isinstance(r, dict)]
        async with self._state_lock:
            if self.auto_execute and not self.state.auto_execute_armed:
                # 首次启用自动执行时，以当前水位为基线：历史 mention.execute 仍入收件箱但不自动执行
                self.state.auto_execute_armed = True
                self.state.arm_baseline_event_id = latest_id
                self.store.save_state(self.state)
                print(
                    f'[自动执行] 已建立基线 event_id={latest_id}（仅执行此后的新 mention.execute）',
                    file=sys.stderr,
                )
            elif not self.auto_execute and self.state.auto_execute_armed:
                # 显式以关闭状态连接时解除 armed，下次重新开启会重建基线
                self.state.auto_execute_armed = False
                self.store.save_state(self.state)

        print(
            f'ready session={self.session_id} watermark={latest_id} rooms={rooms} '
            f'auto_execute={self.auto_execute}',
            flush=True,
        )
        self._ready.set()

    async def _receive(self, socket: Any) -> None:
        async for raw in socket:
            message = json.loads(raw)
            kind = message.get('type')
            if kind == 'heartbeat':
                await socket.send('{"type":"pong"}')
            elif kind == 'ready':
                await self._on_ready(message)
            elif 'event_id' in message:
                await self._offer_live(message)

    async def _worker_loop(self) -> None:
        """串行消费 mention.execute 队列，逐条拉起 agy。"""
        while not self._stop_event.is_set():
            try:
                event_id = await asyncio.wait_for(self._exec_queue.get(), timeout=0.5)
            except TimeoutError:
                continue

            try:
                await self._execute_single_event(event_id)
            finally:
                self._queued_ids.discard(event_id)
                self._exec_queue.task_done()

    async def _execute_single_event(self, event_id: int) -> None:
        key = str(event_id)
        async with self._state_lock:
            info = self.state.deliveries.get(key)
            if not info or info.get('status') != 'pending':
                return
            event = self.store.find_inbox_event(event_id)
            if event is None:
                info['status'] = 'failed'
                info['error'] = '收件箱中未找到对应事件'
                info['updated_at'] = int(time.time())
                self.store.save_state(self.state)
                return

            info['status'] = 'running'
            info['updated_at'] = int(time.time())
            conversation_id = self.state.agy_conversation_id
            self.store.save_state(self.state)

        prompt = build_event_prompt(agent_session_id=self.session_id, event=event, read_only=False)
        print(
            f'[agy] 开始处理 event={event_id} room={event.get("room_id")} msg={event.get("message_id")} '
            f'conversation={conversation_id or "<新建>"}',
            flush=True,
        )
        result = await run_agy_turn(
            prompt=prompt,
            options=self.agy_options,
            conversation_id=conversation_id,
            token_for_redaction=self.auth.token,
        )

        async with self._state_lock:
            if result.conversation_id and not self.state.agy_conversation_id:
                self.state.agy_conversation_id = result.conversation_id
            entry = self.state.deliveries.setdefault(key, {})
            entry['status'] = 'done' if result.ok else 'failed'
            entry['agy_status'] = result.status
            entry['updated_at'] = int(time.time())
            if result.error:
                entry['error'] = sanitize_display(result.error, self.auth.token, limit=300)
            self.store.save_state(self.state)

        if result.ok:
            preview = sanitize_display(result.response, self.auth.token, limit=180)
            print(
                f'[agy] 完成 event={event_id} status={result.status} conversation={result.conversation_id}'
                + (f' reply={preview!r}' if preview else ''),
                flush=True,
            )
        else:
            print(
                f'[agy] 失败 event={event_id} status={result.status} error={result.error}',
                file=sys.stderr,
                flush=True,
            )
        if result.stderr:
            stderr_preview = sanitize_display(result.stderr, self.auth.token, limit=300)
            print(f'[agy stderr] event={event_id} {stderr_preview}', file=sys.stderr, flush=True)

    async def _run_single_session(self) -> None:
        headers = {'Authorization': f'Bearer {self.auth.token}'}
        self._buffer.clear()
        self._overflow = False
        self._catching_up = True
        self._ready = asyncio.Event()

        async with connect(self.ws_url, additional_headers=headers) as socket:
            receiver = asyncio.create_task(self._receive(socket))
            catch_up = asyncio.create_task(self._catch_up())
            stop_waiter = asyncio.create_task(self._stop_event.wait())
            try:
                done, pending = await asyncio.wait(
                    {receiver, catch_up, stop_waiter},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if stop_waiter in done:
                    await socket.close()
                    return
                for task in (receiver, catch_up):
                    if task.done() and not task.cancelled():
                        err = task.exception()
                        if err is not None:
                            raise err
                if catch_up in done and receiver in pending:
                    done2, _ = await asyncio.wait(
                        {receiver, stop_waiter},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if stop_waiter in done2:
                        await socket.close()
                        return
                    err = receiver.exception()
                    if err is not None:
                        raise err
            finally:
                for task in (receiver, catch_up, stop_waiter):
                    task.cancel()
                await asyncio.gather(receiver, catch_up, stop_waiter, return_exceptions=True)

        if self._overflow:
            raise ConnectionError('实时事件缓冲溢出')

    async def run(self) -> int:
        print(
            f'connecting session={self.session_id} cursor={self.state.cursor} '
            f'state_dir={self.store.state_dir} auto_execute={self.auto_execute}',
            file=sys.stderr,
        )
        self._warn_stale_running()
        self._requeue_pending_deliveries()

        worker = asyncio.create_task(self._worker_loop())
        backoff = BACKOFF_START
        try:
            while not self._stop_event.is_set():
                try:
                    await self._run_single_session()
                    if self._stop_event.is_set():
                        return 0
                    backoff = BACKOFF_START
                except ConnectionClosed as closed:
                    code = closed.rcvd.code if closed.rcvd else None
                    if code == 4409:
                        print(
                            '该会话已有另一个客户端在连接（4409 SESSION_ALREADY_CONNECTED）：'
                            '请先关闭另一个客户端，不自动重试。',
                            file=sys.stderr,
                        )
                        return 3
                    if code in (4401, 4403):
                        print(
                            f'连接被拒绝（{code}）：请检查 Bearer 凭证是否有效、会话 {self.session_id} 是否属于当前 Agent。',
                            file=sys.stderr,
                        )
                        return 4
                    print(f'连接断开（{code}），{backoff:.0f}s 后按游标补拉重连', file=sys.stderr)
                except ConnectionError as exc:
                    print(f'{sanitize_display(str(exc), self.auth.token)}，{backoff:.0f}s 后重连', file=sys.stderr)
                except OSError as exc:
                    print(
                        f'网络错误：{sanitize_display(str(exc), self.auth.token)}，{backoff:.0f}s 后重连',
                        file=sys.stderr,
                    )

                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                    return 0
                except TimeoutError:
                    backoff = min(backoff * 2, BACKOFF_MAX)
            return 0
        finally:
            self._stop_event.set()
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
