import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  callJev,
  DEFAULT_MODEL_ID,
  JevRequestError,
  ROUTES,
  ROUTE_CRITERIA,
  type JevDecision,
  type Route,
} from "./jev-client.ts";
import { loadRouterConfig, saveRouterConfig, type RouterConfig } from "./config.ts";
import { loadFixedTasks } from "./tasks.ts";

const DEFAULT_REPETITIONS = 3;
const MAX_REPETITIONS = 10;
const REQUEST_TIMEOUT_MS = 3_000;
const STATUS_KEY = "pi-jev-router";
const SHADOW_LOG_FILENAME = "jev-router-shadow.jsonl";
const CONFIG_FILENAME = "jev-router.json";
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

interface RunResult {
  taskId: string;
  route: Route;
}

function parseRepetitions(args: string): number {
  const value = args.trim();
  if (!value) return DEFAULT_REPETITIONS;
  if (!/^\d+$/.test(value)) throw new Error("用法：/jev-test [重复次数]，范围为 1–10");
  const repetitions = Number(value);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    throw new Error("重复次数必须在 1–10 之间");
  }
  return repetitions;
}

function appendJsonLine(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function appendJsonLineQuietly(path: string, value: Record<string, unknown>): void {
  try {
    appendJsonLine(path, value);
  } catch {
    // Logging must never interrupt the user's task.
  }
}

interface LiveTask {
  taskId: string;
  mode: RouterConfig["mode"];
  sessionId: string;
  mainModel: string;
  logging: boolean;
}

interface EvaluationInput {
  state: string;
  inputChars: number;
  sentChars: number;
  truncated: boolean;
}

function createEvaluationInput(prompt: string, imageCount: number, maxChars: number): EvaluationInput {
  let state = prompt.trim();
  if (imageCount > 0) {
    const note = `[${imageCount} image attachment${imageCount === 1 ? "" : "s"}; image content is not sent to Jev.]`;
    state = state ? `${state}\n\n${note}` : note;
  }
  const inputChars = state.length;
  const truncated = inputChars > maxChars;
  state = state.slice(0, maxChars);
  return { state, inputChars, sentChars: state.length, truncated };
}

function errorCode(error: unknown): string {
  return error instanceof JevRequestError ? error.code : "unexpected_error";
}

async function runEvaluation(
  ctx: ExtensionContext,
  task: LiveTask,
  input: EvaluationInput,
  config: RouterConfig,
): Promise<JevDecision | undefined> {
  const logPath = join(getAgentDir(), SHADOW_LOG_FILENAME);
  const startedAt = Date.now();
  let jevModel = config.model;
  const baseRecord = () => ({
    timestamp: new Date().toISOString(),
    source: task.mode,
    mode: task.mode,
    runId: task.taskId,
    taskId: task.taskId,
    sessionId: task.sessionId,
    mainModel: task.mainModel,
    jevModel,
    inputChars: input.inputChars,
    sentChars: input.sentChars,
    truncated: input.truncated,
  });

  try {
    const model = ctx.modelRegistry.getModelOfType("classifier", "opencode", config.model);
    if (!model) throw new JevRequestError("Jev model is unavailable", "missing_model");
    jevModel = model.id;

    const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
    if (!apiKey) throw new JevRequestError("OpenCode authentication is unavailable", "missing_auth");

    const decision: JevDecision = await callJev({
      apiKey,
      state: input.state,
      modelId: model.id,
      timeoutMs: config.timeoutMs,
    });
    if (config.logging) {
      appendJsonLineQuietly(logPath, {
        ...baseRecord(),
        route: decision.route,
        probabilities: decision.probabilities,
        durationMs: Date.now() - startedAt,
        ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        ...(decision.inputTokens !== undefined ? { inputTokens: decision.inputTokens } : {}),
        ...(decision.outputTokens !== undefined ? { outputTokens: decision.outputTokens } : {}),
      });
    }
    return decision;
  } catch (error) {
    if (config.logging) {
      appendJsonLineQuietly(logPath, {
        ...baseRecord(),
        durationMs: Date.now() - startedAt,
        error: errorCode(error),
      });
    }
    return undefined;
  }
}

function summarize(tasks: { id: string }[], results: RunResult[], repetitions: number): string {
  const totals: Record<Route, number> = { direct: 0, scout: 0, worker: 0, scout_worker: 0 };
  const lines = tasks.map((task) => {
    const counts: Record<Route, number> = { direct: 0, scout: 0, worker: 0, scout_worker: 0 };
    for (const result of results) {
      if (result.taskId !== task.id) continue;
      counts[result.route] += 1;
      totals[result.route] += 1;
    }
    const routes = ROUTES.filter((route) => counts[route] > 0)
      .map((route) => `${route} ${counts[route]}/${repetitions}`)
      .join(", ");
    return `${task.id}: ${routes || "无结果"}`;
  });

  const totalText = ROUTES.map((route) => `${route} ${totals[route]}`).join(" · ");
  return [
    `Jev 对照测试完成（${tasks.length} 个任务 × ${repetitions} 次；${results.length} 次成功）`,
    ...lines,
    `路线总数：${totalText}`,
    "重复一致性仅表示同一输入的结果相似，不代表决策正确率。",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const configPath = join(getAgentDir(), CONFIG_FILENAME);
  const shadowLogPath = join(getAgentDir(), SHADOW_LOG_FILENAME);
  const loaded = loadRouterConfig(configPath);
  let routerConfig = loaded.config;
  let configError = loaded.error;
  let activeTask: LiveTask | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (configError && ctx.hasUI) ctx.ui.notify(configError, "warning");
  });

  pi.registerCommand("jev-router", {
    description: "查看、切换或关闭 Jev 路由评估",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (!["status", "on", "off", "suggest", "shadow"].includes(action)) {
        ctx.ui.notify("用法：/jev-router [status|on|off|suggest|shadow]", "warning");
        return;
      }

      if (action !== "status") {
        const nextConfig =
          action === "off"
            ? { ...routerConfig, enabled: false }
            : action === "suggest" || action === "shadow"
              ? { ...routerConfig, enabled: true, mode: action }
              : { ...routerConfig, enabled: true };
        try {
          saveRouterConfig(configPath, nextConfig);
        } catch {
          ctx.ui.notify(`无法写入 Jev 配置：${configPath}`, "error");
          return;
        }
        routerConfig = nextConfig;
        configError = undefined;
        if (!routerConfig.enabled) activeTask = undefined;
        const message = routerConfig.enabled
          ? routerConfig.mode === "suggest"
            ? "Jev Suggest 已启用；路由建议仅供参考，不会自动调用子代理。"
            : "Jev Shadow 已启用；只记录决策，不注入建议。"
          : "Jev 路由已关闭；不会进行新的评估或注入建议。";
        ctx.ui.notify(message, "info");
        return;
      }

      const model = ctx.modelRegistry.getModelOfType("classifier", "opencode", routerConfig.model);
      let apiKey: string | undefined;
      try {
        apiKey = model ? await ctx.modelRegistry.getApiKeyForProvider(model.provider) : undefined;
      } catch {
        apiKey = undefined;
      }
      const authStatus = !model ? "模型不可用" : apiKey ? "认证可用" : "缺少 OpenCode 认证";
      const modeStatus = routerConfig.mode === "suggest" ? "Suggest" : "Shadow";
      ctx.ui.notify(
        [
          `Jev 路由：${routerConfig.enabled ? `${modeStatus} 已启用` : "已关闭"}（${authStatus}）`,
          `超时 ${routerConfig.timeoutMs} ms；最多发送 ${routerConfig.maxStateChars} 字符；日志 ${routerConfig.logging ? shadowLogPath : "关闭"}`,
          ...(configError ? [configError] : []),
        ].join("\n"),
        routerConfig.enabled && apiKey ? "info" : "warning",
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    delete event.systemPromptOptions.sections.pi_jev_router;
    if (!routerConfig.enabled || process.env[SUBAGENT_CHILD_ENV] === "1") {
      activeTask = undefined;
      return;
    }
    const prompt = event.prompt.trim();
    if (!prompt || prompt.startsWith("/")) {
      activeTask = undefined;
      return;
    }

    const config = { ...routerConfig };
    const input = createEvaluationInput(prompt, event.images?.length ?? 0, config.maxStateChars);
    const task: LiveTask = {
      taskId: randomUUID(),
      mode: config.mode,
      sessionId: ctx.sessionManager.getSessionId(),
      mainModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
      logging: config.logging,
    };
    activeTask = task;

    if (config.mode === "shadow") {
      // Shadow mode records the decision without delaying or modifying the main task.
      void runEvaluation(ctx, task, input, config);
      return;
    }

    const decision = await runEvaluation(ctx, task, input, config);
    if (!decision || !routerConfig.enabled || routerConfig.mode !== "suggest") return;

    const probabilities = ROUTES
      .map((route) => `${route} ${Math.round(decision.probabilities[route] * 100)}%`)
      .join(", ");
    event.systemPromptOptions.sections.pi_jev_router = [
      "## Jev 可选路由建议",
      `Jev 推荐策略：${decision.route}（${ROUTE_CRITERIA[decision.route]}）；策略概率：${probabilities}。`,
      "此建议仅供参考，不是执行指令。遵循用户明确要求，并结合现有工作流、可用工具和你自己的判断决定是否采纳；不要仅因建议而自动调用子代理，也不要更改模型、思考强度、权限或远程执行设置。",
    ].join("\n");
  });

  pi.on("tool_call", (event) => {
    const task = activeTask;
    if (!routerConfig.enabled || !task?.logging || process.env[SUBAGENT_CHILD_ENV] === "1" || event.toolName !== "subagent") return;
    const input = event.input;
    if (input.action !== undefined) return;

    const isWorkflow =
      input.workflow === true ||
      typeof input.workflow === "string" ||
      Array.isArray(input.tasks) ||
      Array.isArray(input.chain);
    const agent = typeof input.agent === "string" ? input.agent.slice(0, 80) : undefined;
    if (!isWorkflow && !agent) return;

    appendJsonLineQuietly(shadowLogPath, {
      timestamp: new Date().toISOString(),
      source: "subagent_call",
      mode: task.mode,
      runId: task.taskId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      mainModel: task.mainModel,
      toolCallId: event.toolCallId,
      ...(isWorkflow ? { kind: "workflow" } : { kind: "agent", agent }),
    });
  });

  pi.on("agent_end", () => {
    activeTask = undefined;
  });

  pi.registerCommand("jev-test", {
    description: "运行固定任务集，重复观察 Jev 的路由倾向（默认每项 3 次）",
    handler: async (args, ctx) => {
      let repetitions: number;
      try {
        repetitions = parseRepetitions(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "重复次数无效", "warning");
        return;
      }

      const model = ctx.modelRegistry.getModelOfType("classifier", "opencode", DEFAULT_MODEL_ID);
      if (!model) {
        ctx.ui.notify(
          `Pi 模型目录中找不到 opencode/${DEFAULT_MODEL_ID}。请确认当前 Pi 模型目录包含该 Jev 模型。`,
          "error",
        );
        return;
      }
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
      if (!apiKey) {
        ctx.ui.notify(
          "未找到 opencode Provider 的认证。请先在 Pi 中配置 OpenCode Zen 登录；扩展不会读取 auth.json，也不需要单独配置 API Key。",
          "error",
        );
        return;
      }

      let tasks: ReturnType<typeof loadFixedTasks>;
      try {
        tasks = loadFixedTasks();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "读取固定测试集失败", "error");
        return;
      }

      const logPath = join(getAgentDir(), "jev-router-phase1.jsonl");
      try {
        mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
        appendFileSync(logPath, "", { encoding: "utf8", mode: 0o600 });
      } catch {
        ctx.ui.notify("无法创建或写入 Jev 测试日志；尚未发送测试请求。", "error");
        return;
      }

      const runId = randomUUID();
      const sessionId = ctx.sessionManager.getSessionId();
      const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      const results: RunResult[] = [];
      const total = tasks.length * repetitions;
      let completed = 0;

      try {
        for (const task of tasks) {
          for (let repetition = 1; repetition <= repetitions; repetition += 1) {
            completed += 1;
            ctx.ui.setStatus(STATUS_KEY, `Jev 对照测试 ${completed}/${total}：${task.id} #${repetition}`);
            const startedAt = Date.now();
            let decision: Awaited<ReturnType<typeof callJev>>;
            try {
              decision = await callJev({
                apiKey,
                state: task.state,
                modelId: model.id,
                timeoutMs: REQUEST_TIMEOUT_MS,
              });
            } catch (error) {
              const durationMs = Date.now() - startedAt;
              const code = error instanceof JevRequestError ? error.code : "unexpected_error";
              try {
                appendJsonLine(logPath, {
                  timestamp: new Date().toISOString(),
                  runId,
                  sessionId,
                  taskId: task.id,
                  repetition,
                  mainModel,
                  jevModel: model.id,
                  durationMs,
                  error: code,
                });
              } catch {
                ctx.ui.notify(`Jev 请求失败，且无法写入日志：${logPath}`, "error");
                return;
              }
              const message = error instanceof JevRequestError ? error.message : "发生未预期错误";
              ctx.ui.notify(
                `Jev 对照测试在 ${task.id} 第 ${repetition} 次请求失败（${message}）；已停止后续请求。\n日志：${logPath}`,
                "error",
              );
              return;
            }

            const durationMs = Date.now() - startedAt;
            const record: Record<string, unknown> = {
              timestamp: new Date().toISOString(),
              runId,
              sessionId,
              taskId: task.id,
              repetition,
              mainModel,
              jevModel: model.id,
              route: decision.route,
              probabilities: decision.probabilities,
              durationMs,
              ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
              ...(decision.inputTokens !== undefined ? { inputTokens: decision.inputTokens } : {}),
              ...(decision.outputTokens !== undefined ? { outputTokens: decision.outputTokens } : {}),
            };
            try {
              appendJsonLine(logPath, record);
            } catch {
              ctx.ui.notify(`Jev 已返回结果，但日志写入失败；已停止后续请求：${logPath}`, "error");
              return;
            }
            results.push({ taskId: task.id, route: decision.route });
          }
        }
      } finally {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }

      ctx.ui.notify(`${summarize(tasks, results, repetitions)}\n日志：${logPath}`, "info");
    },
  });
}
