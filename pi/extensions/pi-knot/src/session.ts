/**
 * 用 Agent Bearer 创建 Knot 会话的一次性 HTTP 调用。
 *
 * 只返回公开身份（id、name）：凭证只进 Authorization 头，不进 URL、日志或错误文本。
 * 结果分成“确定没创建”（服务端有响应，可安全重试）与“不确定”（超时、断网、2xx 但响应
 * 不可解析）：后者调用方必须保留 pending 标记，不能盲目重试，否则每次重连都会多造一个身份。
 */
import type { KnotBase } from "./config.ts";

const CREATE_PATH = "/api/agent/sessions";
const CREATE_TIMEOUT_MS = 15_000;
const REASON_LIMIT = 200;

export type CreateSessionResult =
  | { ok: true; session: { id: number; name: string } }
  | { ok: false; certain: boolean; reason: string };

export async function createRemoteSession(base: KnotBase, name: string): Promise<CreateSessionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
  try {
    const response = await fetch(`${base.restBase}${CREATE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${base.token}`,
      },
      body: JSON.stringify({ name }),
      signal: controller.signal,
      // 不跟随重定向：否则可能把 Authorization 带去别的地址，或在别处真的建出会话。
      redirect: "manual",
    });
    if (response.status !== 201) {
      // 只有“服务端明确拒绝、请求不可能已生效”的状态才算确定没创建。
      // 5xx、重定向、其它 2xx、408/429 都可能已经建好，必须保守保留 pending。
      const certain = isDefinitelyRejected(response.status);
      const detail = await describeFailure(response, base.token);
      return {
        ok: false,
        certain,
        reason:
          `创建 Knot 会话失败（HTTP ${response.status}）：${detail}` +
          (certain ? "" : "；服务端可能已经创建，本次不再自动重试（可先确认后再用 /knot connect <id>）"),
      };
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.id !== "number" || !Number.isSafeInteger(payload.id) || typeof payload.name !== "string") {
      // 2xx 但响应不可信：身份可能已经创建，不能当成“确定没创建”。
      return {
        ok: false,
        certain: false,
        reason: "创建 Knot 会话的响应无法解析；为避免重复创建身份，本次不再自动重试",
      };
    }
    return { ok: true, session: { id: payload.id, name: payload.name } };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    // 连不上（ECONNREFUSED/DNS）也按“结果未知”处理：宁可人工确认，也不要批量造身份。
    return {
      ok: false,
      certain: false,
      reason: aborted
        ? `创建 Knot 会话超时（${CREATE_TIMEOUT_MS / 1000}s）；结果未知，为避免重复创建本次不再自动重试`
        : "创建 Knot 会话时网络失败；结果未知，为避免重复创建本次不再自动重试",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 4xx 里明确“请求被拒绝、不会生效”的状态；408/429 与 5xx、3xx、其它 2xx 都不算。
 * 401/403 代表凭证或权限问题，请求没有进入业务逻辑。
 */
function isDefinitelyRejected(status: number): boolean {
  if (status < 400 || status >= 500) {
    return false;
  }
  return status !== 408 && status !== 429;
}

async function describeFailure(response: Response, token: string): Promise<string> {
  let text = "";
  try {
    text = (await response.text()).split(token).join("***").trim();
  } catch {
    return "服务端未给出原因";
  }
  return text.slice(0, REASON_LIMIT) || "服务端未给出原因";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
