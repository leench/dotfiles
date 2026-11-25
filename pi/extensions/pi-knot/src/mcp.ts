/**
 * 对 Knot MCP 端点（Streamable HTTP，`<restBase>/mcp`）发起一次 `tools/call`。
 *
 * 为什么直接说 MCP 而不是 REST：Agent 只能通过 MCP 工具在 Room 里获得成员关系，
 * `POST /api/rooms/join` 需要人类登录态（backend/api.py: join 用 UserDep），Agent Bearer 走不通。
 *
 * 边界：
 * - 服务端 `/mcp` 是 stateless（backend/mcp.py: create_mcp 用 stateless_http），每次 POST
 *   自带 Bearer 鉴权；带 `MCP-Protocol-Version` 走免 initialize 的分支，不需要会话 ID。
 * - 只发一条请求，不读正文、不发消息、不审批。
 * - 凭证只进 Authorization 头，不进 URL，也不进任何返回文本。
 */
const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 15_000;
const REASON_LIMIT = 300;

export interface KnotToolTarget {
  /** 完整 MCP 地址（同源约束由调用方保证）。 */
  url: string;
  /** 只存在于内存；不打印、不落盘。 */
  token: string;
}

export type KnotToolResult =
  | { ok: true; structured?: Record<string, unknown>; text: string }
  | { ok: false; reason: string };

let sequence = 0;

export async function callKnotTool(
  target: KnotToolTarget,
  name: string,
  args: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<KnotToolResult> {
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const id = `pi-knot-${(sequence += 1)}`;
  if (options.signal?.aborted) {
    return { ok: false, reason: "Knot MCP 请求已取消" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = (): void => controller.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 服务端按 SSE 回一条事件（json_response=False）；同时声明 JSON，服务端改模式也兼容。
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${target.token}`,
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
      // 不跟随重定向：避免把 Authorization 带去别的地址。
      redirect: "manual",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: `Knot 拒绝了凭证（HTTP ${response.status}）` };
      }
      const detail = await safeText(response, target.token);
      return {
        ok: false,
        reason: `Knot MCP 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
      };
    }
    const body = await response.text();
    return parseMcpPayload(response.headers.get("content-type") ?? "", body, id, target.token);
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    if (aborted) {
      return {
        ok: false,
        reason: options.signal?.aborted
          ? "Knot MCP 请求已取消"
          : `Knot MCP 请求超时（${Math.round(timeoutMs / 1000)}s）`,
      };
    }
    return { ok: false, reason: "Knot MCP 请求网络失败" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forward);
  }
}

/**
 * 解析 MCP 响应：JSON 或 SSE（`data:` 行）都接受。
 *
 * 服务端是 stateless，一条 POST 只会得到一条响应；优先用 id 匹配，匹配不上时只在
 * 恰好一个候选的情况下取它，避免把别的响应当成自己的。
 */
export function parseMcpPayload(
  contentType: string,
  body: string,
  id: string,
  token = "",
): KnotToolResult {
  const messages = contentType.includes("text/event-stream") ? parseSse(body) : parseJsonLines(body);
  if (messages.length === 0) {
    return { ok: false, reason: "Knot MCP 响应无法解析" };
  }
  const matched = messages.find((message) => message.id === id);
  const message = matched ?? (messages.length === 1 ? messages[0] : undefined);
  if (!message) {
    return { ok: false, reason: "Knot MCP 响应缺少匹配的请求 ID" };
  }
  if (message.error !== undefined) {
    const detail = isRecord(message.error) && typeof message.error.message === "string" ? message.error.message : "";
    return { ok: false, reason: cleanReason(detail, token) || "Knot MCP 返回错误" };
  }
  const result = isRecord(message.result) ? message.result : undefined;
  if (!result) {
    return { ok: false, reason: "Knot MCP 响应缺少 result" };
  }
  const text = toolText(result, token);
  if (result.isError === true) {
    // 工具级失败（backend/mcp.py 把 DomainError 转成 isError + 文本）：409 席位冲突也走这里。
    return { ok: false, reason: text || "Knot 工具调用失败" };
  }
  const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  return { ok: true, structured, text };
}

/** 从 CallToolResult.content 里取文本（只取 text 块）。 */
function toolText(result: Record<string, unknown>, token: string): string {
  if (!Array.isArray(result.content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of result.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return cleanReason(parts.join("\n"), token);
}

function cleanReason(text: string, token: string): string {
  const redacted = token ? text.split(token).join("***") : text;
  const flat = redacted.replace(/\s+/g, " ").trim();
  return flat.length > REASON_LIMIT ? `${flat.slice(0, REASON_LIMIT)}…` : flat;
}

function parseJsonLines(body: string): Record<string, unknown>[] {
  const parsed = tryJson(body.trim());
  return isRecord(parsed) ? [parsed] : [];
}

function parseSse(body: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length === 0) {
      return;
    }
    const parsed = tryJson(data.join("\n"));
    if (isRecord(parsed)) {
      messages.push(parsed);
    }
    data = [];
  };
  for (const raw of body.split(/\r?\n/)) {
    if (raw === "") {
      flush();
      continue;
    }
    if (raw.startsWith(":")) {
      continue;
    }
    if (raw.startsWith("data:")) {
      data.push(raw.slice(5).replace(/^ /, ""));
    }
  }
  flush();
  return messages;
}

function tryJson(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function safeText(response: Response, token: string): Promise<string> {
  try {
    return cleanReason(await response.text(), token);
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
