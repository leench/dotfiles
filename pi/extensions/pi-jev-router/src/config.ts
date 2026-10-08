import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MODEL_ID } from "./jev-client.ts";

export interface RouterConfig {
  enabled: boolean;
  mode: "shadow";
  model: typeof DEFAULT_MODEL_ID;
  timeoutMs: number;
  maxStateChars: number;
  logging: boolean;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  enabled: true,
  mode: "shadow",
  model: DEFAULT_MODEL_ID,
  timeoutMs: 3_000,
  maxStateChars: 4_000,
  logging: true,
};

export interface LoadedRouterConfig {
  config: RouterConfig;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfig(): LoadedRouterConfig {
  return {
    config: { ...DEFAULT_ROUTER_CONFIG, enabled: false },
    error: "配置无效；为避免意外发送任务，Shadow 已关闭。运行 /jev-router on 可重写配置。",
  };
}

export function loadRouterConfig(path: string): LoadedRouterConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { config: { ...DEFAULT_ROUTER_CONFIG } };
    }
    return {
      config: { ...DEFAULT_ROUTER_CONFIG, enabled: false },
      error: "无法读取配置；为避免意外发送任务，Shadow 已关闭。运行 /jev-router on 可重写配置。",
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidConfig();
  }
  if (!isRecord(value)) return invalidConfig();

  const enabled = value.enabled === undefined ? DEFAULT_ROUTER_CONFIG.enabled : value.enabled;
  const mode = value.mode === undefined ? DEFAULT_ROUTER_CONFIG.mode : value.mode;
  const model = value.model === undefined ? DEFAULT_ROUTER_CONFIG.model : value.model;
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_ROUTER_CONFIG.timeoutMs : value.timeoutMs;
  const maxStateChars = value.maxStateChars === undefined ? DEFAULT_ROUTER_CONFIG.maxStateChars : value.maxStateChars;
  const logging = value.logging === undefined ? DEFAULT_ROUTER_CONFIG.logging : value.logging;

  if (
    typeof enabled !== "boolean" ||
    mode !== "shadow" ||
    model !== DEFAULT_MODEL_ID ||
    typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
    typeof maxStateChars !== "number" || !Number.isSafeInteger(maxStateChars) || maxStateChars < 1 || maxStateChars > 4_000 ||
    typeof logging !== "boolean"
  ) {
    return invalidConfig();
  }

  return {
    config: { enabled, mode, model, timeoutMs, maxStateChars, logging },
  };
}

export function saveRouterConfig(path: string, config: RouterConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
