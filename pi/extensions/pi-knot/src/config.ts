/**
 * Knot 配置：独立文件 ${agentDir}/knot.json + 四个 KNOT_* 环境变量覆盖。
 *
 * 安全边界：Token 优先从 KNOT_AGENT_TOKEN 读取，否则复用用户级 Knot MCP 的同源 Bearer；
 * 仅保存在内存，不复制到 knot.json、URL、日志或会话记录。校验失败只返回可直接展示的中文原因，
 * 原因文本里不含 Token。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactToken } from "./format.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SECRET_KEYS = /token|authorization|bearer|secret|password/i;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const BEARER_HEADER = /^Bearer[ \t]+(\S+)$/i;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HTTP_MCP_TYPES = new Set(["http", "streamable-http"]);

/**
 * 只含与服务/凭证有关的基础配置。Knot 会话 ID 不再从全局配置读取：它属于当前
 * Pi 对话的本地绑定（见 store.ts 的正反绑定），用 bindSession() 拼成完整配置。
 */
export interface KnotBase {
  /** 规范化后的 REST 基址（origin + 路径前缀，无尾斜杠）。 */
  restBase: string;
  /** 只存在于内存；不落盘、不打印。 */
  token: string;
  /** 安全来源标签：环境变量或用户级 mcp.json。 */
  tokenSource: "env" | "mcp-json";
  /** 是否自动把 mention.execute（主人已审批）送交当前会话；默认关闭。 */
  autoExecuteMentions: boolean;
  allowLocalhost: boolean;
  /** 旧版全局 agentSessionId：仅用于提示“可用 /knot connect <id> 显式选用”，绝不自动认领。 */
  legacySessionId?: number;
  configFile: string;
  dataDir: string;
}

export interface KnotConfig extends KnotBase {
  agentSessionId: number;
  wsUrl: string;
  /** 按规范化服务地址 + Knot 会话 ID 隔离；不含 Token。 */
  serviceKey: string;
  stateDir: string;
}

/** 把一份基础配置与一个具体的 Knot 会话 ID 合成为本对话使用的完整配置。 */
export function bindSession(base: KnotBase, agentSessionId: number): KnotConfig {
  const rest = new URL(base.restBase);
  const prefix = rest.pathname === "/" ? "" : rest.pathname.replace(/\/+$/, "");
  const serviceKey = createHash("sha256").update(`${base.restBase}|${agentSessionId}`).digest("hex").slice(0, 16);
  return {
    ...base,
    agentSessionId,
    wsUrl: `${rest.protocol === "https:" ? "wss:" : "ws:"}//${rest.host}${prefix}/ws/agent-sessions/${agentSessionId}`,
    serviceKey,
    stateDir: join(base.dataDir, serviceKey, String(agentSessionId)),
  };
}

export type ConfigResult =
  | { ok: true; config: KnotBase; warnings: string[] }
  | { ok: false; missing: boolean; reason: string };

/** 配置问题；message 可直接展示。 */
export class ConfigError extends Error {}

export function resolveAgentDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (!override) {
    return join(homedir(), ".pi", "agent");
  }
  if (override === "~" || override.startsWith("~/")) {
    return join(homedir(), override.slice(1));
  }
  return override;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ConfigResult {
  const agentDir = resolveAgentDir(env);
  const configFile = join(agentDir, "knot.json");
  const dataDir = join(agentDir, "pi-knot");
  const warnings: string[] = [];
  const mcpFile = join(agentDir, "mcp.json");
  // 先取环境变量里的 Token：非空则优先于 mcp.json，同时用于给回显字段脱敏。
  const tokenRaw = typeof env.KNOT_AGENT_TOKEN === "string" ? env.KNOT_AGENT_TOKEN.trim() : "";

  let fileValues: Record<string, unknown> | undefined;
  if (existsSync(configFile)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configFile, "utf8"));
    } catch {
      return { ok: false, missing: false, reason: `无法解析 Knot 配置文件 ${configFile}（需要 JSON 对象）` };
    }
    if (!isRecord(parsed)) {
      return { ok: false, missing: false, reason: `Knot 配置文件 ${configFile} 必须是 JSON 对象` };
    }
    fileValues = parsed;
    for (const key of Object.keys(parsed)) {
      if (SECRET_KEYS.test(key)) {
        // 键名本身来自外部文件，也可能是凭证内容：只回显安全字符，否则用通用文案。
        const label = redactToken(key, tokenRaw).replace(/[^\w.-]/g, "?").slice(0, 40);
        warnings.push(
          label && !label.includes("***") && label !== tokenRaw
            ? `已忽略配置文件中的 ${label} 字段：凭证只从 KNOT_AGENT_TOKEN 或用户级 mcp.json 读取`
            : "已忽略配置文件中的疑似凭证字段：凭证只从 KNOT_AGENT_TOKEN 或用户级 mcp.json 读取",
        );
      }
    }
  }

  const restRaw = pickValue(env.KNOT_REST_URL, fileValues?.restUrl);
  const wsRaw = pickValue(env.KNOT_WS_URL, fileValues?.wsUrl);
  const sessionRaw = pickValue(env.KNOT_AGENT_SESSION_ID, fileValues?.agentSessionId);
  const allowLocalhost = toBoolean(fileValues?.allowLocalhost);
  const autoRaw = fileValues?.autoExecuteMentions;
  if (autoRaw !== undefined && typeof autoRaw !== "boolean") {
    return { ok: false, missing: false, reason: "autoExecuteMentions 必须是 true 或 false" };
  }
  const autoExecuteMentions = autoRaw === true;

  if (!restRaw && !wsRaw && !sessionRaw && !tokenRaw) {
    return {
      ok: false,
      missing: true,
      reason:
        `未配置 Knot：请创建 ${configFile}（参考 knot.example.json），并设置 KNOT_AGENT_TOKEN` +
        ` 或在用户级 ${mcpFile} 的 mcpServers.knot 里提供 Authorization: Bearer`,
    };
  }

  const missing: string[] = [];
  if (!restRaw) missing.push("KNOT_REST_URL / restUrl");
  if (missing.length > 0) {
    return { ok: false, missing: false, reason: `Knot 配置不完整，缺少：${missing.join("、")}` };
  }

  try {
    const rest = parseRest(restRaw as string, allowLocalhost);
    const legacySessionId = sessionRaw ? parseSessionId(sessionRaw) : undefined;
    const resolvedToken = resolveToken(env, tokenRaw, mcpFile, rest);
    if (!resolvedToken.ok) {
      return { ok: false, missing: false, reason: resolvedToken.reason };
    }
    warnings.push(...resolvedToken.warnings);
    if (allowLocalhost && isLocalhost(rest.hostname)) {
      warnings.push("当前使用明文 localhost 连接，仅限本地开发");
    }
    return {
      ok: true,
      warnings,
      config: {
        restBase: normalizeRest(rest),
        token: resolvedToken.token,
        tokenSource: resolvedToken.source,
        autoExecuteMentions,
        allowLocalhost,
        legacySessionId,
        configFile,
        dataDir,
      },
    };
  } catch (error) {
    return {
      ok: false,
      missing: false,
      reason: error instanceof ConfigError ? error.message : "Knot 配置校验失败",
    };
  }
}

function parseSessionId(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError("KNOT_AGENT_SESSION_ID / agentSessionId 必须是正整数");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError("KNOT_AGENT_SESSION_ID / agentSessionId 必须是正整数");
  }
  return value;
}

function parseRest(raw: string, allowLocalhost: boolean): URL {
  const url = parseUrl(raw, "KNOT_REST_URL / restUrl");
  if (url.username || url.password) {
    throw new ConfigError("REST 地址不能包含用户名或密码");
  }
  if (url.search || url.hash) {
    throw new ConfigError("REST 地址不能包含查询串或片段（凭证只放在 Authorization 头）");
  }
  const local = isLocalhost(url.hostname);
  if (url.protocol === "http:" && allowLocalhost && local) {
    return url;
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(
      local
        ? "访问 localhost 需要在该配置文件里显式设置 allowLocalhost: true；生产必须使用 HTTPS"
        : "REST 地址必须使用 HTTPS（生产不允许明文 HTTP）",
    );
  }
  return url;
}

function normalizeRest(rest: URL): string {
  return `${rest.protocol === "https:" ? "https:" : "http:"}//${rest.host}${rest.pathname === "/" ? "" : rest.pathname.replace(/\/+$/, "")}`;
}

function parseUrl(raw: string, label: string): URL {
  try {
    return new URL(raw.trim());
  } catch {
    throw new ConfigError(`${label} 不是合法的 URL`);
  }
}

function isLocalhost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

function pickValue(envValue: string | undefined, fileValue: unknown): string | undefined {
  const fromEnv = typeof envValue === "string" ? envValue.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  if (typeof fileValue === "string" && fileValue.trim()) {
    return fileValue.trim();
  }
  if (typeof fileValue === "number" && Number.isFinite(fileValue)) {
    return String(fileValue);
  }
  return undefined;
}

function toBoolean(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResolvedToken =
  | { ok: true; token: string; source: "env" | "mcp-json"; warnings: string[] }
  | { ok: false; reason: string };

/**
 * 凭证优先级：非空 KNOT_AGENT_TOKEN → 用户级 <agentDir>/mcp.json 的 mcpServers.knot。
 *
 * - 环境变量已设置但格式无效：直接失败，绝不静默回退到 mcp.json；
 * - 只读用户级文件，不读项目级 .pi/mcp.json、mcp-auth.json 或其他 MCP 服务的凭证；
 * - 只接受 HTTP 条目上、与 REST 同源的 Bearer 头；${VAR} 只做纯环境替换，不执行 !command；
 * - 任何失败信息都不包含凭证值。
 */
function resolveToken(
  env: Record<string, string | undefined>,
  fromEnv: string,
  mcpFile: string,
  rest: URL,
): ResolvedToken {
  if (fromEnv) {
    if (!TOKEN_PATTERN.test(fromEnv)) {
      return { ok: false, reason: "KNOT_AGENT_TOKEN 已设置但格式无效（只允许可打印 ASCII，不含空白与控制字符）" };
    }
    return { ok: true, token: fromEnv, source: "env", warnings: [] };
  }
  const fromMcp = readMcpToken(mcpFile, rest, env);
  if (!fromMcp.ok) {
    return fromMcp;
  }
  // 复用 mcp.json 的 Bearer 是正常路径，不再作为启动警告；缺凭证的情况由下面的 reason 报错。
  return { ok: true, token: fromMcp.token, source: "mcp-json", warnings: [] };
}

type McpToken = { ok: true; token: string } | { ok: false; reason: string };

function readMcpToken(mcpFile: string, rest: URL, env: Record<string, string | undefined>): McpToken {
  if (!existsSync(mcpFile)) {
    return {
      ok: false,
      reason:
        `未找到 Knot 凭证：请设置 KNOT_AGENT_TOKEN，或在用户级 ${mcpFile} 的 mcpServers.knot 中配置 ` +
        "Authorization: Bearer <token>",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(mcpFile, "utf8"));
  } catch {
    return { ok: false, reason: `无法解析用户级 ${mcpFile}（不会回显文件内容）` };
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return { ok: false, reason: `用户级 ${mcpFile} 缺少 mcpServers 对象` };
  }
  const entry = parsed.mcpServers.knot;
  if (!isRecord(entry)) {
    return { ok: false, reason: `用户级 ${mcpFile} 中没有 mcpServers.knot 条目` };
  }
  if (entry.enabled === false) {
    return { ok: false, reason: "用户级 mcp.json 的 knot 条目已禁用（enabled: false）" };
  }
  if (entry.command !== undefined || entry.type === "stdio") {
    return { ok: false, reason: "用户级 mcp.json 的 knot 条目是 stdio 形式，不能复用其凭证" };
  }
  if (entry.type !== undefined && (typeof entry.type !== "string" || !HTTP_MCP_TYPES.has(entry.type))) {
    return { ok: false, reason: "用户级 mcp.json 的 knot 条目不是 HTTP 形式，不能复用其凭证" };
  }
  if (typeof entry.url !== "string") {
    return { ok: false, reason: "用户级 mcp.json 的 knot 条目缺少 url" };
  }
  let mcpUrl: URL;
  try {
    mcpUrl = new URL(entry.url);
  } catch {
    return { ok: false, reason: "用户级 mcp.json 的 knot url 不是合法 URL" };
  }
  if (mcpUrl.username || mcpUrl.password) {
    return { ok: false, reason: "用户级 mcp.json 的 knot url 不能包含用户名或密码" };
  }
  if (mcpUrl.origin !== rest.origin) {
    return {
      ok: false,
      reason: `用户级 mcp.json 的 knot url 与 KNOT_REST_URL 不同源（需为 ${rest.origin}）`,
    };
  }
  if (!isRecord(entry.headers)) {
    return {
      ok: false,
      reason: isRecord(entry.oauth)
        ? "用户级 mcp.json 的 knot 条目使用 OAuth，不复用其凭证；请设置 KNOT_AGENT_TOKEN"
        : "用户级 mcp.json 的 knot 条目没有 Authorization 头",
    };
  }
  const headerKey = Object.keys(entry.headers).find((key) => key.toLowerCase() === "authorization");
  if (!headerKey) {
    return {
      ok: false,
      reason: isRecord(entry.oauth)
        ? "用户级 mcp.json 的 knot 条目使用 OAuth，不复用其凭证；请设置 KNOT_AGENT_TOKEN"
        : "用户级 mcp.json 的 knot 条目没有 Authorization 头",
    };
  }
  const value = entry.headers[headerKey];
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: "用户级 mcp.json 的 knot Authorization 头不是非空字符串" };
  }
  if (value.trim().startsWith("!")) {
    return {
      ok: false,
      reason: "用户级 mcp.json 的 knot Authorization 使用了 !command 形式，本插件不执行命令获取凭证",
    };
  }
  const expanded = expandEnvReferences(value, env);
  if (!expanded.ok) {
    return {
      ok: false,
      reason: `用户级 mcp.json 的 knot Authorization 引用了未设置的环境变量：${expanded.missing.join("、")}`,
    };
  }
  const match = BEARER_HEADER.exec(expanded.value.trim());
  if (!match) {
    return { ok: false, reason: "用户级 mcp.json 的 knot Authorization 不是 Bearer 形式（不支持其他认证方式）" };
  }
  if (!TOKEN_PATTERN.test(match[1])) {
    return { ok: false, reason: "用户级 mcp.json 的 knot Bearer Token 格式无效（只允许可打印 ASCII，不含空白与控制字符）" };
  }
  return { ok: true, token: match[1] };
}

function expandEnvReferences(
  value: string,
  env: Record<string, string | undefined>,
): { ok: true; value: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const replaced = value.replace(ENV_REFERENCE, (_match, name: string) => {
    const resolved = typeof env[name] === "string" ? env[name].trim() : "";
    if (!resolved) {
      missing.push(name);
      return "";
    }
    return resolved;
  });
  if (missing.length > 0) {
    return { ok: false, missing: [...new Set(missing)] };
  }
  if (/\$\{/.test(replaced)) {
    return { ok: false, missing: ["<未解析的变量>"] };
  }
  return { ok: true, value: replaced };
}
