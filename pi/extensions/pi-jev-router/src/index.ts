import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  callJev,
  DEFAULT_MODEL_ID,
  JevRequestError,
  ROUTES,
  ROUTE_CRITERIA,
  ROUTE_EXECUTION_INSTRUCTIONS,
  type JevDecision,
  type Route,
} from "./jev-client.ts";
import { loadRouterConfig, saveRouterConfig, type RouterConfig } from "./config.ts";
import { loadFixedTasks } from "./tasks.ts";
import {
  collectRecentHistory,
  createEvaluationInput,
  formatDecisionLine,
  formatFailureLine,
  messageText,
  type EvaluationInput,
} from "./history.ts";

const DEFAULT_REPETITIONS = 3;
const MAX_REPETITIONS = 10;
const REQUEST_TIMEOUT_MS = 3_000;
const STATUS_KEY = "pi-jev-router";
const JUDGE_WIDGET_KEY = "pi-jev-router-judge";
const JUDGE_ENTRY_TYPE = "jev-router-decision";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
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

type EvaluationOutcome = { ok: true; decision: JevDecision } | { ok: false; code: string };

/** 一轮路由评估：结果行落位前保存在 rounds 中；会话更换后在途结果作废。 */
interface JudgeRound extends LiveTask {
  prompt: string;
  leafIdAtStart: string | null;
  /** 生成号：session_shutdown 后递增，旧生成的在途结果不再写入。 */
  generation: number;
  ended: boolean;
  /** 已算出但尚未落位的结果行；每轮各自一个槽位，不会互相覆盖。 */
  pendingLine?: string;
}

function errorCode(error: unknown): string {
  return error instanceof JevRequestError ? error.code : "unexpected_error";
}

async function runEvaluation(
  ctx: ExtensionContext,
  task: LiveTask,
  input: EvaluationInput,
  config: RouterConfig,
): Promise<EvaluationOutcome> {
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
    return { ok: true, decision };
  } catch (error) {
    const code = errorCode(error);
    if (config.logging) {
      appendJsonLineQuietly(logPath, {
        ...baseRecord(),
        durationMs: Date.now() - startedAt,
        error: code,
      });
    }
    return { ok: false, code };
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
  let activeTask: JudgeRound | undefined;
  let sessionGeneration = 0;
  /** 在途轮次：结果行落位后移除；会话关闭时整体作废。 */
  const rounds = new Map<string, JudgeRound>();
  /** TUI 判断中动画：一个 interval 覆盖当前 session generation 内所有在途评估。 */
  let judgeSpinner: { ctx: ExtensionContext; timer: ReturnType<typeof setInterval>; tasks: Set<string> } | undefined;

  /** 移除某个在途评估；全部结束后才清 status 与 interval。不传 taskId 时无条件停止。 */
  function stopJudgeSpinner(taskId?: string): void {
    const spinner = judgeSpinner;
    if (!spinner) return;
    if (taskId !== undefined) {
      spinner.tasks.delete(taskId);
      if (spinner.tasks.size > 0) return; // 仍有评估在途，动画继续
    }
    judgeSpinner = undefined;
    clearInterval(spinner.timer);
    try {
      spinner.ctx.ui.setWidget(JUDGE_WIDGET_KEY, undefined);
    } catch {
      // 会话已被替换，没有可清理的 widget。
    }
  }

  function startJudgeSpinner(ctx: ExtensionContext, taskId: string): void {
    if (ctx.mode !== "tui") return; // 非 TUI 不创建终端 widget
    const spinner = judgeSpinner;
    if (spinner) {
      spinner.tasks.add(taskId); // 已有动画在跑：只登记，不影响其他在途评估
      return;
    }
    let frame = 0;
    const render = () => {
      const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      frame += 1;
      try {
        // Text treats a trailing newline as one blank row beneath the spinner.
        ctx.ui.setWidget(JUDGE_WIDGET_KEY, [`${glyph} Jev 判断中…\n`], { placement: "aboveEditor" });
      } catch {
        stopJudgeSpinner(); // widget 不可用：整体停止，避免每帧重试
      }
    };
    render();
    judgeSpinner = { ctx, timer: setInterval(render, SPINNER_INTERVAL_MS), tasks: new Set([taskId]) };
  }

  function appendJudgeLine(line: string): void {
    try {
      pi.appendEntry(JUDGE_ENTRY_TYPE, { text: line });
    } catch {
      // 扩展运行时已卸载（reload 或切换会话），结果只保留在 JSONL 日志里。
    }
  }

  /** 结果行现在能否安全追加：本轮已结束，或本轮提问已经是 branch 末尾。 */
  function canAppendJudgeLine(ctx: ExtensionContext, round: JudgeRound): boolean {
    return round.ended || promptEntryLanded(ctx, round.prompt, round.leafIdAtStart);
  }

  /**
   * 追加 pending 结果行。all=true 时无条件追加（新一轮开始前，新 prompt 尚未落盘，
   * 追加位置就是上一轮末尾）；否则只追加已经可以落位的行。会话更换后的行直接丢弃。
   */
  function flushJudgeLines(ctx: ExtensionContext, all: boolean): void {
    for (const round of rounds.values()) {
      const line = round.pendingLine;
      if (line === undefined) continue;
      const stale = round.generation !== sessionGeneration;
      if (!stale && !all && !canAppendJudgeLine(ctx, round)) continue;
      round.pendingLine = undefined;
      rounds.delete(round.taskId);
      if (!stale) appendJudgeLine(line);
    }
  }

  /** 本轮 user 条目是否已经落盘：文本匹配当前 prompt；图片归一化可能只在末尾附加提示。 */
  function promptEntryLanded(ctx: ExtensionContext, prompt: string, leafIdAtStart: string | null): boolean {
    const branch = ctx.sessionManager.getBranch();
    const leaf = branch[branch.length - 1];
    if (!leaf || leaf.type !== "message" || leaf.id === leafIdAtStart) return false;
    if (leaf.message.role !== "user") return false;
    const text = messageText(leaf.message);
    return text === prompt || text.startsWith(`${prompt}\n\n`);
  }

  /** 结果行落位；本轮提问尚未落盘时挂起，只有会话更换才丢弃。 */
  function showJudgeLine(ctx: ExtensionContext, round: JudgeRound, outcome: EvaluationOutcome): void {
    if (round.generation !== sessionGeneration) return; // 会话已更换：不写入旧会话或新会话
    const line = outcome.ok
      ? formatDecisionLine(round.mode, outcome.decision.route, outcome.decision.probabilities)
      : formatFailureLine(round.mode, outcome.code);

    if (canAppendJudgeLine(ctx, round)) {
      rounds.delete(round.taskId);
      appendJudgeLine(line);
      return;
    }
    round.pendingLine = line;
  }

  pi.registerEntryRenderer<{ text: string }>(JUDGE_ENTRY_TYPE, (entry, _options, theme) => {
    const text = entry.data?.text;
    if (!text) return undefined;
    return new Text(theme.fg("dim", text), 1, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    // 新会话（或重载）之前启动的轮次一律作废，避免迟到结果写入当前会话。
    sessionGeneration += 1;
    rounds.clear();
    stopJudgeSpinner();
    if (configError && ctx.hasUI) ctx.ui.notify(configError, "warning");
  });

  pi.on("session_shutdown", () => {
    sessionGeneration += 1; // 在途结果作废：不再写入旧会话或之后的新会话
    stopJudgeSpinner();
    activeTask = undefined;
    rounds.clear();
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
            ? "Jev Suggest 已启用；主代理已收到按路由委派的执行要求（direct 除外）。"
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
    flushJudgeLines(ctx, true); // 旧轮次未落盘的结果行先补写
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
    const history = collectRecentHistory(ctx.sessionManager.getBranch());
    const input = createEvaluationInput(prompt, history, event.images?.length ?? 0, config.maxStateChars);
    const round: JudgeRound = {
      taskId: randomUUID(),
      mode: config.mode,
      sessionId: ctx.sessionManager.getSessionId(),
      mainModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
      logging: config.logging,
      prompt,
      leafIdAtStart: ctx.sessionManager.getLeafId(),
      generation: sessionGeneration,
      ended: false,
    };
    activeTask = round;
    rounds.set(round.taskId, round);
    startJudgeSpinner(ctx, round.taskId);

    if (config.mode === "shadow") {
      // Shadow mode records the decision without delaying or modifying the main task.
      void (async () => {
        try {
          const outcome = await runEvaluation(ctx, round, input, config);
          showJudgeLine(ctx, round, outcome);
        } catch {
          // 后台评估不应作为未处理的 Promise 拒绝冒泡出来。
        } finally {
          stopJudgeSpinner(round.taskId);
        }
      })();
      return;
    }

    let outcome: EvaluationOutcome;
    try {
      outcome = await runEvaluation(ctx, round, input, config);
    } finally {
      stopJudgeSpinner(round.taskId);
    }
    if (outcome.ok && routerConfig.enabled && routerConfig.mode === "suggest") {
      const decision = outcome.decision;
      const probabilities = ROUTES
        .map((route) => `${route} ${Math.round(decision.probabilities[route] * 100)}%`)
        .join(", ");
      event.systemPromptOptions.sections.pi_jev_router = [
        "## Jev 路由执行要求",
        `Jev 选择策略：${decision.route}（${ROUTE_CRITERIA[decision.route]}）；策略概率：${probabilities}。`,
        "把该路由作为本轮执行策略，而非可选建议。",
        ROUTE_EXECUTION_INSTRUCTIONS[decision.route],
        "遵守用户明确提出的委派与修改范围限制；若用户禁止委派，或 subagent 工具/指定 agent 不可用，明确说明无法按路由派发，不要声称已经调用。不要更改模型、思考强度、权限或远程执行设置。",
      ].join("\n");
    }
    showJudgeLine(ctx, round, outcome);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "user") return;
    // This extension hook runs before SessionManager persists the user entry.
    // Defer one event-loop turn so the result is appended after the prompt, before model latency.
    setTimeout(() => flushJudgeLines(ctx, false), 0);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    flushJudgeLines(ctx, false);
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

  pi.on("agent_end", (_event, ctx) => {
    if (activeTask) activeTask.ended = true;
    activeTask = undefined;
    // 结果晚于本轮答复时补写在答复之后，而不是丢到下一条 message_start。
    flushJudgeLines(ctx, false);
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
