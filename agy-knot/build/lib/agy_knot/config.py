"""配置与凭证解析：严格遵守 Knot 凭证边界，绝不打印或落盘 Token。"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_MCP_CONFIG_PATH = Path.home() / '.gemini' / 'config' / 'mcp_config.json'
DEFAULT_STATE_ROOT = Path.home() / '.knot' / 'agy-knot'
DEFAULT_MCP_SERVER_NAME = 'knot'
_ENV_VAR_RE = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}')


class ConfigError(RuntimeError):
    """配置或凭证校验失败。"""


@dataclass(frozen=True)
class KnotAuth:
    """已校验的 Knot 服务端点与 Bearer 凭证。"""

    rest_url: str
    ws_base_url: str
    token: str
    source: str  # 'env' 或 'mcp_config'


def normalize_rest_url(raw: str) -> str:
    """规范化 Knot 服务基址，去除 /mcp 后缀和末尾斜杠。"""
    text = raw.strip().rstrip('/')
    parsed = urlparse(text)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise ConfigError(f'无效的 Knot 服务地址：{raw!r}')
    path = parsed.path.rstrip('/').removesuffix('/mcp')
    return f'{parsed.scheme}://{parsed.netloc}{path}'.rstrip('/')


def rest_to_ws_base(rest_url: str) -> str:
    """将 http(s) 基址转为 ws(s) 基址。"""
    if rest_url.startswith('https://'):
        return 'wss://' + rest_url[len('https://') :]
    if rest_url.startswith('http://'):
        return 'ws://' + rest_url[len('http://') :]
    raise ConfigError(f'不支持的协议：{rest_url!r}')


def same_origin(url_a: str, url_b: str) -> bool:
    """判断两个 URL 是否同源（scheme + netloc）。"""
    a = urlparse(url_a)
    b = urlparse(url_b)
    return a.scheme.lower() == b.scheme.lower() and a.netloc.lower() == b.netloc.lower()


def redact_token(text: str, token: str | None) -> str:
    """从文本中清除 Token，防止泄漏到日志、收件箱或异常信息。"""
    if not token:
        return text
    return text.replace(token, '***')


def sanitize_display(text: str, token: str | None = None, limit: int = 200) -> str:
    """清洗不可信展示文本（去除控制字符、脱敏 Token 并截断）。"""
    cleaned = redact_token(text, token)
    cleaned = re.sub(r'[\x00-\x1f\x7f]', ' ', cleaned).strip()
    if len(cleaned) > limit:
        return cleaned[:limit] + '…'
    return cleaned


def _validate_token(raw: str, source_label: str) -> str:
    token = raw.strip()
    if not token or any(ch.isspace() for ch in token):
        raise ConfigError(f'{source_label} 中的 Knot Token 格式非法（为空或包含空白字符）')
    return token


def _expand_env_placeholders(value: str) -> str:
    def _replace(match: re.Match[str]) -> str:
        var_name = match.group(1)
        env_val = os.environ.get(var_name)
        if env_val is None or not env_val.strip():
            raise ConfigError(f'mcp_config.json 引用了未设置的环境变量 ${{{var_name}}}')
        return env_val

    return _ENV_VAR_RE.sub(_replace, value)


def _read_mcp_knot_entry(mcp_config_path: Path, server_name: str) -> tuple[str, str]:
    """从全局 mcp_config.json 读取 Knot 服务地址与 Bearer Token。"""
    if not mcp_config_path.is_file():
        raise ConfigError(f'未找到 Antigravity MCP 配置文件：{mcp_config_path}')
    try:
        raw = json.loads(mcp_config_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f'无法解析 MCP 配置文件 {mcp_config_path}：{exc.__class__.__name__}') from exc

    if not isinstance(raw, dict):
        raise ConfigError(f'MCP 配置文件根节点必须是 JSON 对象：{mcp_config_path}')
    servers = raw.get('mcpServers')
    if not isinstance(servers, dict) or server_name not in servers:
        raise ConfigError(f'MCP 配置文件中未找到 mcpServers.{server_name}')

    entry = servers[server_name]
    if not isinstance(entry, dict):
        raise ConfigError(f'mcpServers.{server_name} 配置格式无效')
    if entry.get('disabled') is True:
        raise ConfigError(f'mcpServers.{server_name} 已被禁用（disabled=true）')

    raw_url = entry.get('serverUrl') or entry.get('url')
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise ConfigError(f'mcpServers.{server_name} 缺少远程 serverUrl/url（仅支持 Streamable HTTP）')
    rest_url = normalize_rest_url(raw_url)

    headers = entry.get('headers')
    if not isinstance(headers, dict):
        raise ConfigError(f'mcpServers.{server_name} 缺少 headers.Authorization 配置')

    auth_header: str | None = None
    for key, val in headers.items():
        if isinstance(key, str) and key.lower() == 'authorization' and isinstance(val, str):
            auth_header = val
            break
    if not auth_header:
        raise ConfigError(f'mcpServers.{server_name} 未配置 Authorization 请求头')

    expanded = _expand_env_placeholders(auth_header).strip()
    if not expanded.lower().startswith('bearer '):
        raise ConfigError(f'mcpServers.{server_name} 的 Authorization 头必须使用 Bearer 认证')
    token = _validate_token(expanded[7:], f'{mcp_config_path} (mcpServers.{server_name})')
    return rest_url, token


def resolve_auth(
    *,
    rest_url_override: str | None = None,
    mcp_config_path: Path | None = None,
    server_name: str = DEFAULT_MCP_SERVER_NAME,
) -> KnotAuth:
    """按优先级解析 Knot 端点与 Bearer Token。

    优先级：
    1. 环境变量 KNOT_AGENT_TOKEN（若已设置但非法，直接报错不回退）。
    2. 全局 ~/.gemini/config/mcp_config.json 中的 mcpServers.knot。
    若同时指定了 rest_url_override 且回退读取 mcp_config.json，要求二者同源。
    """
    cfg_path = mcp_config_path or Path(os.environ.get('AGY_MCP_CONFIG', str(DEFAULT_MCP_CONFIG_PATH))).expanduser()
    env_url = os.environ.get('KNOT_REST_URL', '').strip()
    explicit_url = normalize_rest_url(rest_url_override or env_url) if (rest_url_override or env_url) else None

    env_token_present = 'KNOT_AGENT_TOKEN' in os.environ
    if env_token_present:
        token = _validate_token(os.environ['KNOT_AGENT_TOKEN'], '环境变量 KNOT_AGENT_TOKEN')
        if explicit_url is not None:
            rest_url = explicit_url
        else:
            # 仅从 mcp_config.json 借用 URL（如果存在）
            mcp_url, _ = _read_mcp_knot_entry(cfg_path, server_name)
            rest_url = mcp_url
        return KnotAuth(
            rest_url=rest_url,
            ws_base_url=rest_to_ws_base(rest_url),
            token=token,
            source='env',
        )

    mcp_url, token = _read_mcp_knot_entry(cfg_path, server_name)
    if explicit_url is not None and not same_origin(explicit_url, mcp_url):
        raise ConfigError(
            f'指定的 Knot 地址 ({explicit_url}) 与 {cfg_path} 中的同源地址 ({mcp_url}) 不一致，拒绝复用凭证'
        )
    rest_url = explicit_url or mcp_url
    return KnotAuth(
        rest_url=rest_url,
        ws_base_url=rest_to_ws_base(rest_url),
        token=token,
        source='mcp_config',
    )


def resolve_state_dir(profile: str = 'default', state_dir_override: str | None = None) -> Path:
    """解析当前 profile 的状态目录。"""
    if state_dir_override:
        return Path(state_dir_override).expanduser().resolve()
    env_dir = os.environ.get('AGY_KNOT_STATE_DIR', '').strip()
    if env_dir:
        return Path(env_dir).expanduser().resolve()
    safe_profile = re.sub(r'[^A-Za-z0-9._-]', '_', profile.strip() or 'default')
    return (DEFAULT_STATE_ROOT / safe_profile).resolve()
