/**
 * 项目级自动加入 Room。
 *
 * 配置：项目根 `<cwd>/.pi/knot.json` 的 `autoJoin` 数组，每项可以是加入链接字符串，
 * 或 `{ "link": "...", "replaceOffline": true }`。默认不接替任何席位。
 *
 * 边界（与 Knot 服务端契约一致，见 backend/services.py: join_room）：
 * - 加入链接就是秘密：不写通知、状态栏、日志，也不拼进任何 URL；只作为工具参数发给
 *   已配置的同源 MCP 端点。
 * - 自动接替只在“服务端明确判定原席位**无活跃连接**、且本会话**未被接替过**”时发起，
 *   并且该 Room 配置了 `replaceOffline: true`；在线、状态未知、曾被接替一律只通知。
 * - 接替不声明 `confirmed_by_user`：没有用户当场确认，就不能替用户宣称已同意。
 * - 逐个串行处理，单个失败不影响后续；不做重试。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnotBase } from "./config.ts";
import { callKnotTool } from "./mcp.ts";

const MAX_ENTRIES = 20;
const REASON_LIMIT = 300;
/** 服务端 seat_id = secrets.token_hex(16)（backend/services.py）。 */
const SEAT_TOKEN = /expected_seat_id=([0-9a-f]{32})/;
/**
 * 下面几句直接引用服务端拒接文本（backend/services.py: _seat_taken_message / _SEAT_PRESENCE_TEXT）。
 * 服务端改了措辞时这些不是“猜”，而是识别不到→降级成只通知，绝不会误接替。
 */
const SEAT_OCCUPIED = "该 Agent 已有会话在此 Room";
const SEAT_ONLINE = "该会话在线，有活跃的 Agent WS 连接";
const SEAT_OFFLINE = "该会话当前无活跃连接";
const SEAT_UNKNOWN = "它的在线状态无法判断";
const SEAT_REPLACED = "本会话已被接替过";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{6,}$/;

export interface AutoJoinEntry {
  /** 加入链接或令牌本身：属于秘密，绝不进入展示文本。 */
  link: string;
  /** 仅当服务端明确判定原席位无活跃连接、且本会话未被接替过时才自动接替。 */
  replaceOffline: boolean;
}

export type ProjectAutoJoinResult =
  /** missing=true 表示没有配置文件或没有配置 autoJoin：保持现状，不提示。 */
  | { ok: true; entries: AutoJoinEntry[]; warnings: string[] }
  | { ok: false; missing: boolean; reason: string };

export function projectAutoJoinFile(cwd: string): string {
  return join(cwd, ".pi", "knot.json");
}

/** 读取并校验项目级配置；问题只返回可直接展示的原因（不含链接）。 */
export function loadProjectAutoJoin(cwd: string, restBase: string): ProjectAutoJoinResult {
  const file = projectAutoJoinFile(cwd);
  if (!existsSync(file)) {
    return { ok: false, missing: true, reason: `未找到 ${file}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, missing: false, reason: `无法解析项目配置 ${file}（需要 JSON 对象）` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, missing: false, reason: `项目配置 ${file} 必须是 JSON 对象` };
  }
  const raw = parsed.autoJoin;
  if (raw === undefined) {
    return { ok: false, missing: true, reason: `项目配置 ${file} 没有 autoJoin` };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, missing: false, reason: "autoJoin 必须是数组" };
  }
  if (raw.length > MAX_ENTRIES) {
    return { ok: false, missing: false, reason: `autoJoin 最多 ${MAX_ENTRIES} 项` };
  }
  let origin: string | undefined;
  try {
    origin = new URL(restBase).origin;
  } catch {
    origin = undefined;
  }
  const warnings: string[] = [];
  const entries: AutoJoinEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const label = `autoJoin[${index + 1}]`;
    const entry = parseEntry(item, label, origin, warnings);
    if (!entry) {
      return;
    }
    if (seen.has(entry.link)) {
      return;
    }
    seen.add(entry.link);
    entries.push(entry);
  });
  return { ok: true, entries, warnings };
}

function parseEntry(
  item: unknown,
  label: string,
  origin: string | undefined,
  warnings: string[],
): AutoJoinEntry | undefined {
  let link: unknown = item;
  let replaceOffline = false;
  if (isRecord(item)) {
    link = item.link;
    if (item.replaceOffline !== undefined) {
      if (typeof item.replaceOffline !== "boolean") {
        warnings.push(`${label} 的 replaceOffline 必须是 true 或 false，已忽略该项`);
        return undefined;
      }
      replaceOffline = item.replaceOffline;
    }
    for (const key of Object.keys(item)) {
      if (key !== "link" && key !== "replaceOffline") {
        warnings.push(`${label} 含未知字段 ${safeKey(key)}，已忽略`);
      }
    }
  }
  if (typeof link !== "string" || !link.trim()) {
    warnings.push(`${label} 缺少非空的 link，已忽略该项`);
    return undefined;
  }
  const checked = normalizeLink(link.trim(), origin);
  if (!checked.ok) {
    warnings.push(`${label} ${checked.reason}，已忽略该项`);
    return undefined;
  }
  return { link: checked.link, replaceOffline };
}

/**
 * 链接规范化：接受完整的 http(s) 加入链接（`#<n>` 楼层会被去掉）或裸令牌。
 * 完整链接必须与配置的服务地址同源，避免把凭证发到长得像 Knot 的其他站点。
 */
export function normalizeLink(
  raw: string,
  origin: string | undefined,
): { ok: true; link: string } | { ok: false; reason: string } {
  if (TOKEN_SHAPE.test(raw)) {
    return { ok: true, link: raw };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "不是完整的加入链接或令牌" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "加入链接必须是 http(s) 地址" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "加入链接不能包含用户名或密码" };
  }
  if (url.search) {
    return { ok: false, reason: "加入链接不能带查询串" };
  }
  if (origin && url.origin !== origin) {
    return { ok: false, reason: "加入链接的主域与服务地址不同源" };
  }
  url.hash = "";
  return { ok: true, link: url.toString() };
}

export interface SeatRefusal {
  /** 服务端占位独有令牌；旧数据没有令牌时为 undefined。 */
  seatId?: string;
  presence: "online" | "offline" | "unknown" | "unparsed";
  /** 本会话在这个 Room 已经失去过席位：永不允许自动接替。 */
  replaced: boolean;
}

/** 解析服务端 409 拒接文本（backend/services.py: _seat_taken_message）。 */
export function parseSeatRefusal(text: string): SeatRefusal {
  const match = SEAT_TOKEN.exec(text);
  const presence = text.includes(SEAT_ONLINE)
    ? "online"
    : text.includes(SEAT_OFFLINE)
      ? "offline"
      : text.includes(SEAT_UNKNOWN)
        ? "unknown"
        : "unparsed";
  return {
    seatId: match?.[1],
    presence,
    replaced: text.includes(SEAT_REPLACED),
  };
}

export type AutoJoinStatus = "joined" | "replaced" | "refused" | "failed";

export interface AutoJoinOutcome {
  /** 展示用编号（1 起），不对应配置文件下标以外的任何身份。 */
  index: number;
  status: AutoJoinStatus;
  roomId?: number;
  title?: string;
  /** 已脱敏、截断的原因；不含链接与席位令牌。 */
  reason?: string;
}

export interface JoinRoomOptions {
  base: KnotBase;
  agentSessionId: number;
  entry: AutoJoinEntry;
  index: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 一个 Room 的加入流程：先普通加入，必要时再按服务端契约接替离线席位。 */
export async function joinProjectRoom(options: JoinRoomOptions): Promise<AutoJoinOutcome> {
  const { base, agentSessionId, entry, index } = options;
  const target = { url: `${base.restBase}/mcp`, token: base.token };
  const call = (args: Record<string, unknown>) =>
    callKnotTool(target, "join_room", { ...args, agent_session_id: agentSessionId }, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

  const first = await call({ link: entry.link });
  if (first.ok) {
    return { index, status: "joined", ...roomOf(first.structured, first.text) };
  }
  if (!first.reason.includes(SEAT_OCCUPIED)) {
    return { index, status: "failed", reason: first.reason };
  }
  const refusal = parseSeatRefusal(first.reason);
  if (refusal.replaced) {
    return { index, status: "refused", reason: "席位由本 Agent 的其他会话占用，且本会话在此已被接替过，不自动抢回" };
  }
  if (refusal.presence === "online") {
    return { index, status: "refused", reason: "席位由本 Agent 的其他会话占用（该会话在线），不自动接替" };
  }
  if (refusal.presence !== "offline") {
    return { index, status: "refused", reason: "席位由本 Agent 的其他会话占用，在线状态无法确认，不自动接替" };
  }
  if (!refusal.seatId) {
    return { index, status: "refused", reason: "席位由本 Agent 的旧式成员占用且没有席位令牌，无法接替" };
  }
  if (!entry.replaceOffline) {
    return { index, status: "refused", reason: "席位由本 Agent 的其他会话占用（当前无活跃连接），未开启 replaceOffline，不自动接替" };
  }
  const second = await call({ link: entry.link, replace_existing: true, expected_seat_id: refusal.seatId });
  if (second.ok) {
    return { index, status: "replaced", ...roomOf(second.structured, second.text) };
  }
  if (second.reason.includes("需要用户明确同意")) {
    return { index, status: "refused", reason: "接替需要用户明确同意（占位会话在线或本会话已被接替过），未自动接替" };
  }
  if (second.reason.includes("席位已经变化")) {
    return { index, status: "refused", reason: "席位在两次调用之间已经变化，未接替" };
  }
  return { index, status: "failed", reason: second.reason };
}

function roomOf(structured: Record<string, unknown> | undefined, text: string): { roomId?: number; title?: string } {
  const source = structured ?? parsedText(text);
  if (!source) {
    return {};
  }
  const roomId =
    typeof source.id === "number" && Number.isSafeInteger(source.id) && source.id > 0 ? source.id : undefined;
  const title = typeof source.title === "string" ? source.title.slice(0, 80) : undefined;
  return { roomId, title };
}

function parsedText(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 结果汇总：成功的合并成一条，失败的逐条带上可执行的原因。 */
export function formatAutoJoinResults(outcomes: AutoJoinOutcome[]): { info?: string; warnings: string[] } {
  const joined: string[] = [];
  const replaced: string[] = [];
  const warnings: string[] = [];
  for (const outcome of outcomes) {
    const room = describeRoom(outcome);
    if (outcome.status === "joined") {
      joined.push(room);
      continue;
    }
    if (outcome.status === "replaced") {
      replaced.push(room);
      continue;
    }
    const prefix = outcome.status === "refused" ? "未自动接替" : "加入失败";
    warnings.push(`Knot 项目自动加入 autoJoin[${outcome.index}]：${prefix}，${trimReason(outcome.reason)}`);
  }
  const lines: string[] = [];
  if (joined.length > 0) {
    lines.push(`已加入 ${joined.join("、")}`);
  }
  if (replaced.length > 0) {
    lines.push(`已接替离线席位 ${replaced.join("、")}`);
  }
  return lines.length > 0 ? { info: `Knot 项目自动加入：${lines.join("；")}`, warnings } : { warnings };
}

function describeRoom(outcome: AutoJoinOutcome): string {
  const title = outcome.title ? `「${outcome.title}」` : "";
  return outcome.roomId !== undefined ? `Room #${outcome.roomId}${title}` : "Room（未返回编号）";
}

function trimReason(reason: string | undefined): string {
  if (!reason) {
    return "原因未知";
  }
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}…` : reason;
}

function safeKey(key: string): string {
  return key.replace(/[^\w.-]/g, "?").slice(0, 40) || "?";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
