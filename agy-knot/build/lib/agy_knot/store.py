"""本地状态目录管理：单实例锁、state.json 原子持久化、inbox.jsonl 收件箱。"""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Self, TextIO

from agy_knot.config import redact_token, sanitize_display


class LockConflictError(RuntimeError):
    """同状态目录已有另一个 agy-knot 实例在运行。"""


class InstanceLock:
    """基于 fcntl.flock 的单实例文件锁，进程异常退出后由内核自动释放。"""

    def __init__(self, lock_path: Path) -> None:
        self.lock_path = lock_path
        self._fp: TextIO | None = None

    def acquire(self) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        fp = self.lock_path.open('a+', encoding='utf-8')
        try:
            fcntl.flock(fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            fp.seek(0)
            holder = fp.read().strip() or 'unknown'
            fp.close()
            raise LockConflictError(f'状态目录已被另一个 agy-knot 进程锁定（{holder}）') from exc
        fp.seek(0)
        fp.truncate()
        fp.write(f'pid={os.getpid()} started_at={int(time.time())}\n')
        fp.flush()
        self._fp = fp

    def release(self) -> None:
        if self._fp is None:
            return
        try:
            fcntl.flock(self._fp.fileno(), fcntl.LOCK_UN)
        finally:
            self._fp.close()
            self._fp = None

    def __enter__(self) -> Self:
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


@dataclass
class BridgeState:
    """单个 profile 的持久化状态。"""

    rest_url: str = ''
    agent_session_id: int | None = None
    agent_session_name: str = ''
    create_pending: bool = False
    agy_conversation_id: str = ''
    cursor: int = 0
    auto_execute_armed: bool = False
    arm_baseline_event_id: int = 0
    deliveries: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BridgeState:
        raw_sid = data.get('agent_session_id')
        sid = raw_sid if isinstance(raw_sid, int) and not isinstance(raw_sid, bool) else None
        raw_deliveries = data.get('deliveries')
        deliveries = raw_deliveries if isinstance(raw_deliveries, dict) else {}
        return cls(
            rest_url=str(data.get('rest_url', '')),
            agent_session_id=sid,
            agent_session_name=str(data.get('agent_session_name', '')),
            create_pending=bool(data.get('create_pending', False)),
            agy_conversation_id=str(data.get('agy_conversation_id', '')),
            cursor=int(data.get('cursor', 0) or 0),
            auto_execute_armed=bool(data.get('auto_execute_armed', False)),
            arm_baseline_event_id=int(data.get('arm_baseline_event_id', 0) or 0),
            deliveries=deliveries,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            'rest_url': self.rest_url,
            'agent_session_id': self.agent_session_id,
            'agent_session_name': self.agent_session_name,
            'create_pending': self.create_pending,
            'agy_conversation_id': self.agy_conversation_id,
            'cursor': self.cursor,
            'auto_execute_armed': self.auto_execute_armed,
            'arm_baseline_event_id': self.arm_baseline_event_id,
            'deliveries': self.deliveries,
        }


class StateStore:
    """管理 state.json 与 inbox.jsonl 的读写。"""

    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.state_path = state_dir / 'state.json'
        self.inbox_path = state_dir / 'inbox.jsonl'
        self.lock_path = state_dir / 'runner.lock'

    def load_state(self) -> BridgeState:
        if not self.state_path.is_file():
            return BridgeState()
        raw = json.loads(self.state_path.read_text(encoding='utf-8'))
        if not isinstance(raw, dict):
            raise TypeError(f'状态文件格式损坏：{self.state_path}')
        return BridgeState.from_dict(raw)

    def save_state(self, state: BridgeState) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=self.state_dir, prefix='.state-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as fp:
                json.dump(state.to_dict(), fp, ensure_ascii=False, indent=2)
                fp.write('\n')
                fp.flush()
                os.fsync(fp.fileno())
            os.replace(tmp_name, self.state_path)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    def append_inbox(self, event: dict[str, Any], token: str) -> dict[str, Any]:
        """清洗事件索引并追加写入 inbox.jsonl；若敏感字段包含凭证则拒绝。"""
        version = event.get('message_version')
        if token and isinstance(version, str) and token in version:
            raise ValueError('事件 message_version 命中凭证，拒绝写入收件箱')

        raw_sender = event.get('sender')
        sender: dict[str, Any] = raw_sender if isinstance(raw_sender, dict) else {}
        record: dict[str, Any] = {
            'event_id': int(event['event_id']),
            'type': sanitize_display(str(event.get('type', '')), token, limit=64),
            'room_id': event.get('room_id'),
            'message_id': event.get('message_id'),
            'seq': event.get('seq'),
            'mention_id': event.get('mention_id'),
            'message_version': sanitize_display(str(version), token, limit=128) if version is not None else None,
            'sender': {
                'kind': sanitize_display(str(sender.get('kind', '')), token, limit=32),
                'id': sender.get('id'),
                'name': sanitize_display(str(sender.get('name', '')), token, limit=80),
            },
            'summary': sanitize_display(str(event.get('summary', '')), token, limit=240),
            'received_at': int(time.time()),
        }
        line = redact_token(json.dumps(record, ensure_ascii=False), token) + '\n'
        self.state_dir.mkdir(parents=True, exist_ok=True)
        with self.inbox_path.open('a', encoding='utf-8') as fp:
            fp.write(line)
            fp.flush()
        return record

    def read_inbox(self) -> list[dict[str, Any]]:
        if not self.inbox_path.is_file():
            return []
        items: list[dict[str, Any]] = []
        for raw_line in self.inbox_path.read_text(encoding='utf-8').splitlines():
            line = raw_line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                items.append(parsed)
        return items

    def find_inbox_event(self, event_id: int) -> dict[str, Any] | None:
        for item in reversed(self.read_inbox()):
            if item.get('event_id') == event_id:
                return item
        return None
