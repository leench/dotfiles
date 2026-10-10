import { createProxyFetch } from "./proxy-fetch.ts";

export const SYSTEMONE_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
export const DEFAULT_MODEL_ID = "jev-1.13-free";

export const ROUTES = ["direct", "scout", "worker"] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_CRITERIA: Record<Route, string> = {
  direct: "任务简单，主代理直接处理更高效，或必须由主代理完成且不适合委派",
  scout: "只读侦察：需要调查代码或解决不确定性，且不需要修改文件或执行有副作用的命令",
  worker: "需求明确且需要实际实施或执行命令，适合交给 Worker；包括文件修改、提交或推送等操作",
};

export const ROUTE_EXECUTION_INSTRUCTIONS: Record<Route, string> = {
  direct: "直接处理当前用户任务，不要调用 subagent。",
  scout: '必须实际调用 Pi 的 subagent 工具，指定 agent: "scout"，只委派只读调查；scout 不得修改文件、提交、推送或执行有副作用的操作。等待侦察结果后，由主代理继续完成原始请求中需要执行的部分。不要只说会委派。',
  worker: '必须实际调用 Pi 的 subagent 工具，指定 agent: "worker"，把需要实施或执行的当前用户请求作为 task；收到结果后审查并确认任务完成。不要只说会委派。',
};

export interface JevDecision {
  route: Route;
  probabilities: Record<Route, number>;
  confidence?: number;
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface JevRequestOptions {
  apiKey: string;
  state: string;
  modelId?: string;
  timeoutMs?: number;
  proxyUrl?: string | null;
  fetchImpl?: typeof fetch;
}

export class JevRequestError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "JevRequestError";
    this.code = code;
  }
}

export function createRequestBody(state: string, modelId = DEFAULT_MODEL_ID) {
  return {
    model: modelId,
    state,
    questions: {
      route: {
        type: "choice" as const,
        instructions:
          "选择整体成本最低且适合完成任务的执行策略。考虑任务明确程度、代码探索需求、实现工作量及上下文成本。",
        criteria: ROUTE_CRITERIA,
      },
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function invalidResponse(): never {
  throw new JevRequestError("Jev API 返回了不符合预期的决策结果", "invalid_response");
}

/** Parse the documented System One choice answer; no prose or guessed fields are used. */
export function parseJevResponse(value: unknown): JevDecision {
  const envelope = asRecord(value);
  const answers = asRecord(envelope?.answers);
  const answer = asRecord(answers?.route);
  if (!answer || answer.type !== "choice") return invalidResponse();

  const route = answer.choice;
  if (typeof route !== "string" || !ROUTES.includes(route as Route)) return invalidResponse();

  const rawProbabilities = asRecord(answer.probabilities);
  if (!rawProbabilities) return invalidResponse();
  const probabilities = {} as Record<Route, number>;
  for (const option of ROUTES) {
    const probability = rawProbabilities[option];
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      return invalidResponse();
    }
    probabilities[option] = probability;
  }

  const confidence = answer.confidence;
  const responseModel = envelope?.model;
  const usage = asRecord(envelope?.usage);
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;

  return {
    route: route as Route,
    probabilities,
    ...(typeof confidence === "number" && Number.isFinite(confidence) ? { confidence } : {}),
    ...(typeof responseModel === "string" ? { responseModel } : {}),
    ...(typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
  };
}

export async function callJev(options: JevRequestOptions): Promise<JevDecision> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      const fetchImpl = options.fetchImpl ?? (options.proxyUrl ? createProxyFetch(options.proxyUrl) : fetch);
      response = await fetchImpl(SYSTEMONE_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(createRequestBody(options.state, options.modelId)),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new JevRequestError(`Jev 请求超时（${timeoutMs}ms）`, "timeout");
      }
      throw new JevRequestError("无法连接 Jev System One API", "network_error");
    }

    if (!response.ok) {
      throw new JevRequestError(`Jev System One API 返回 HTTP ${response.status}`, `http_${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new JevRequestError(`Jev 请求超时（${timeoutMs}ms）`, "timeout");
      }
      throw new JevRequestError("Jev API 返回的内容不是有效 JSON", "invalid_json");
    }

    return parseJevResponse(payload);
  } finally {
    clearTimeout(timeout);
  }
}
