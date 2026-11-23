"""通过 Knot REST API 创建 Agent Session，区分确定拒绝与结果未知。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass

from agy_knot.config import KnotAuth, sanitize_display

CREATE_PATH = '/api/agent/sessions'
CREATE_TIMEOUT_SEC = 15.0


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """禁止跟随 3xx 重定向，避免把 Authorization 头带到其他主机或重复建会话。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


_OPENER = urllib.request.build_opener(_NoRedirectHandler)


@dataclass(frozen=True)
class CreateSessionResult:
    ok: bool
    session_id: int | None = None
    session_name: str | None = None
    certain: bool = False
    reason: str = ''


def create_remote_session(auth: KnotAuth, name: str) -> CreateSessionResult:
    """调用 POST /api/agent/sessions 创建会话。

    - HTTP 201 且响应可信：ok=True
    - 4xx（非 408/429）：ok=False, certain=True（确定未创建，可安全重试）
    - 3xx/5xx/408/429/超时/断网/2xx 响应异常：ok=False, certain=False（结果未知，必须保留 pending）
    """
    url = f'{auth.rest_url}{CREATE_PATH}'
    body = json.dumps({'name': name}).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {auth.token}',
        },
    )

    try:
        with _OPENER.open(req, timeout=CREATE_TIMEOUT_SEC) as resp:
            status = resp.status
            raw_bytes = resp.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            detail = sanitize_display(exc.read().decode('utf-8', errors='replace'), auth.token)
        except OSError:
            detail = '服务端未给出原因'
        certain = 400 <= status < 500 and status not in (408, 429)
        suffix = '' if certain else '；服务端可能已创建，本次不再自动重试（请确认后用 agy-knot connect <id> 绑定）'
        return CreateSessionResult(
            ok=False,
            certain=certain,
            reason=f'创建 Knot 会话失败（HTTP {status}）：{detail or "服务端未给出原因"}{suffix}',
        )
    except TimeoutError:
        return CreateSessionResult(
            ok=False,
            certain=False,
            reason=f'创建 Knot 会话超时（{int(CREATE_TIMEOUT_SEC)}s）；结果未知，为避免重复创建不再自动重试',
        )
    except OSError as exc:
        detail = sanitize_display(str(exc), auth.token)
        return CreateSessionResult(
            ok=False,
            certain=False,
            reason=f'创建 Knot 会话网络失败（{detail}）；结果未知，为避免重复创建不再自动重试',
        )

    if status != 201:
        return CreateSessionResult(
            ok=False,
            certain=False,
            reason=f'创建 Knot 会话返回非预期状态码（HTTP {status}）；结果未知，为避免重复创建不再自动重试',
        )

    try:
        payload = json.loads(raw_bytes.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return CreateSessionResult(
            ok=False,
            certain=False,
            reason='创建 Knot 会话的响应无法解析；为避免重复创建不再自动重试',
        )

    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get('id'), int)
        or isinstance(payload.get('id'), bool)
        or not isinstance(payload.get('name'), str)
    ):
        return CreateSessionResult(
            ok=False,
            certain=False,
            reason='创建 Knot 会话响应缺少合法的 id/name 字段；为避免重复创建不再自动重试',
        )

    return CreateSessionResult(
        ok=True,
        session_id=payload['id'],
        session_name=payload['name'],
    )
