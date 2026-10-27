/**
 * pi-knot：把一个 Pi 会话接到一个明确的 Knot agent session 的 WebSocket 通知。
 *
 * 默认只做“通知 + 本地收件箱”：事件不会自动进入模型上下文，也不会自动回复或执行；
 * 只有用户显式执行 `/knot read <event_id>` 时，才把该事件的定位信息作为自定义消息
 * （display: true）交给当前 Pi 会话，由模型按需用已有的 Knot MCP 读取正文。
 *
 * 可选 `autoExecuteMentions: true`（默认关闭）时，额外把“主人本人直接 @ 或主人已审批”
 * 产生的结构化 mention.execute 自动送交同一个 Pi 会话（仍是可见的 followUp 消息，
 * 不另开 agent）；read 仍然只是查看，不授权执行。
 *
 * 生命周期：factory 只注册；session_start 启动非阻塞连接；session_shutdown 同步幂等清理。
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { resolveAgentDir, loadConfig, type KnotConfig } from "./src/config.ts";
import {
  StateStore,
  type AutoState,
  acquireStateLock,
  bindingPath,
  checkBinding,
  lockPath,
  rememberBinding,
  requireBinding,
  shortId,
  type StateLock,
  type StoredEvent,
} from "./src/store.ts";
import { KnotClient, type ClientStatus } from "./src/client.ts";
import { buildAutoExecuteMessage, buildReadMessage, formatEventDetail, formatEventLabel } from "./src/format.ts";

const STATUS_KEY = "knot";
const NOTIFY_DELAY_MS = 4_000;
const INBOX_PAGE_SIZE = 50;
const INBOX_PREV = "← 上一页";
const INBOX_NEXT = "下一页 →";

export default function knotExtension(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;

  const disposeRuntime = (): void => {
    const current = runtime;
    runtime = undefined;
    current?.dispose();
  };

  pi.on("session_start", (_event, ctx) => {
    disposeRuntime();
    runtime = new Runtime(pi, ctx);
    runtime.start();
  });

  pi.on("session_shutdown", () => {
    disposeRuntime();
  });

  // agent_settled：一轮 agent 完全结束（含重试/压缩/排队续跑）后才算空闲。
  // 用它做自动投递的串行节流，不用 agent_end。
  pi.on("agent_settled", (_event, ctx) => {
    runtime?.onAgentSettled(ctx);
  });

  pi.registerCommand("knot", {
    description: "Knot 通知：status | connect | disconnect | inbox | read <event_id>",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trim();
      if (text.includes(" ")) {
        return null;
      }
      const matches = ["status", "connect", "disconnect", "inbox", "read"]
        .filter((name) => name.startsWith(text))
        .map((name) => ({ value: name, label: name }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!runtime || !runtime.matches(ctx)) {
        disposeRuntime();
        runtime = new Runtime(pi, ctx);
        runtime.start();
      }
      await runtime.command(args, ctx);
    },
  });
}

class Runtime {
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly piSessionId: string;
  private config?: KnotConfig;
  private configProblem?: string;
  private warnings: string[] = [];
  private store?: StateStore;
  private lock?: StateLock;
  private lockTransient = false;
  private lockProblem?: string;
  private bindingProblem?: string;
  private client?: KnotClient;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private pendingNotice = 0;
  private stoppedByUser = false;
  private disposed = false;
  /** 同一时刻只投递一条，后续在 agent_settled 后继续。 */
  private dispatching = false;
  /**
   * 已成功提交一条自动投递，等这次 agent_settled 才解除。
   * 不能只靠 ctx.isIdle()：Pi 在 _isEmittingAgentSettled 期间会把 sendMessage 延后，
   * 此时 isIdle 仍为 true，连续帧会堆进 deferred 队列。
   */
  private awaitingSettle = false;
  private stateProblem?: string;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
    this.pi = pi;
    this.ctx = ctx;
    this.piSessionId = ctx.sessionManager.getSessionId();
  }

  matches(ctx: ExtensionContext): boolean {
    return ctx.sessionManager.getSessionId() === this.piSessionId;
  }

  /** session_start：同步完成配置/快照读取，连接本身不 await。 */
  start(): void {
    if (this.disposed) {
      return;
    }
    const loaded = this.load();
    this.renderStatus();
    if (!loaded || !this.isInteractive()) {
      // JSON/print/rpc 不自动建立长连接：既不能弹框，也不能让一次性调用因句柄无法退出。
      return;
    }
    if (this.warnings.length > 0) {
      this.notify(this.warnings.join("；"), "warning");
    }
    this.connect(true);
  }

  /** 读取配置与收件箱快照；失败时写入 configProblem，不保留旧配置。 */
  private load(): boolean {
    this.config = undefined;
    this.store = undefined;
    const result = loadConfig();
    if (!result.ok) {
      this.warnings = [];
      this.configProblem = result.reason;
      return false;
    }
    this.config = result.config;
    this.warnings = result.warnings;
    this.configProblem = undefined;
    try {
      const store = new StateStore(result.config.stateDir, result.config.serviceKey, result.config.agentSessionId);
      store.open();
      // 注意：这里只读取快照，绝不写入。写入发生在拿到独占锁并通过正反绑定校验之后。
      this.store = store;
      return true;
    } catch (error) {
      this.configProblem = errorText(error);
      return false;
    }
  }

  private isInteractive(): boolean {
    return this.ctx.mode === "tui";
  }

  /** 所有 UI 文本（含远端字段）统一脱敏，凭证不会经错误/警告回显。 */
  private redact(text: string): string {
    const token = this.config?.token;
    return token ? text.split(token).join("***") : text;
  }

  /** 同步、幂等：停连接、取消定时器、释放锁、清状态栏。 */
  dispose(): void {
    this.disposed = true;
    this.clearNoticeTimer();
    this.client?.stop();
    this.client = undefined;
    this.releaseLock();
    try {
      this.ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // /reload 后旧 ctx 已失效；新 runtime 会设置自己的状态栏。
    }
  }

  async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    switch (subcommand) {
      case "status":
        this.showStatus();
        return;
      case "connect":
        this.connect(false);
        return;
      case "disconnect":
        this.disconnect();
        return;
      case "inbox":
        await this.showInbox(ctx);
        return;
      case "read":
        this.readEvent(rest[0]);
        return;
      default:
        this.notify(`未知子命令：${subcommand}。可用：status | connect | disconnect | inbox | read <event_id>`, "warning");
    }
  }

  private connect(auto: boolean): void {
    if (this.disposed) {
      return;
    }
    if (!auto && !this.isInteractive()) {
      // 非 TUI 模式不允许建立长连接：不弹框、不创建 socket/定时器，也不让一次性调用无法退出。
      return;
    }
    if (this.client?.running) {
      if (!auto) {
        this.notify("Knot 已在连接中", "info");
      }
      return;
    }
    if (this.client) {
      // 上一轮已停止（例如 4409/4401）：先清掉再按当前配置重试。
      this.client.stop();
      this.client = undefined;
    }
    if (!auto) {
      // 显式连接：重新读取配置与收件箱，让用户建好配置/换好凭证后可以直接重试。
      this.releaseLock();
      this.bindingProblem = undefined;
      this.lockProblem = undefined;
      if (!this.load()) {
        this.renderStatus();
        this.notify(this.configProblem ?? "Knot 未配置", "error");
        return;
      }
    } else if (!this.config || !this.store) {
      this.renderStatus();
      return;
    }
    const config = this.config;
    const store = this.store;
    if (!config || !store) {
      this.renderStatus();
      return;
    }
    const lockProblem = this.ensureLock();
    if (lockProblem) {
      this.lockProblem = lockProblem;
      this.renderStatus();
      this.notify(lockProblem, "error");
      return;
    }
    try {
      const context = {
        dataDir: config.dataDir,
        stateDir: config.stateDir,
        serviceKey: config.serviceKey,
        agentSessionId: config.agentSessionId,
        piSessionId: this.piSessionId,
      };
      checkBinding(context);
      rememberBinding(context);
    } catch (error) {
      this.releaseLock();
      this.bindingProblem = errorText(error);
      this.renderStatus();
      this.notify(this.bindingProblem, "error");
      return;
    }
    this.lockProblem = undefined;
    this.bindingProblem = undefined;
    this.stateProblem = undefined;
    this.lockTransient = false;
    this.stoppedByUser = false;
    this.awaitingSettle = false;
    // 只有此刻（独占锁 + 正反绑定都通过）才允许写共享快照：
    // 关闭开关时解除武装，下次重新开启会从新的 ready 水位重建起点，
    // 不会把“关闭期间”积压的旧事件当成新指令。
    if (!config.autoExecuteMentions && store.auto?.armed) {
      try {
        store.setAuto({ armed: false, baseline: store.auto.baseline });
      } catch (error) {
        this.releaseLock();
        this.stateProblem = `无法保存 Knot 自动处理状态：${errorText(error)}`;
        this.renderStatus();
        this.notify(this.stateProblem, "error");
        return;
      }
    }
    const client = new KnotClient({
      config,
      store,
      onChange: () => {
        this.renderStatus();
        if (this.client?.status === "connected") {
          this.maybeDispatchAuto();
        }
      },
      onEvents: (added) => this.noteEvents(added),
      onReady: (info) => this.onRelayReady(info.latestEventId),
    });
    this.client = client;
    client.start();
    this.renderStatus();
    if (!auto) {
      this.notify(`正在连接 Knot 会话 ${config.agentSessionId}`, "info");
    }
  }

  private disconnect(): void {
    this.clearNoticeTimer();
    this.awaitingSettle = false;
    this.client?.stop();
    this.client = undefined;
    this.releaseLock();
    this.stoppedByUser = true;
    this.renderStatus();
    this.notify("已断开 Knot；绑定与未读收件箱保留，/knot connect 可重新连接", "info");
  }

  private async showInbox(ctx: ExtensionCommandContext): Promise<void> {
    if (!this.isInteractive()) {
      return;
    }
    const problem = this.beginCommand();
    if (problem) {
      this.notify(problem, "error");
      return;
    }
    try {
      const store = this.store as StateStore;
      if (store.events.length === 0) {
        this.notify("Knot 收件箱为空", "info");
        return;
      }
      let page = 1;
      // 分页而不是只给最近 N 条：否则超出 N 条的旧未读事件永远无法在 UI 里发现。
      while (!this.disposed) {
        const events = [...store.events].sort((left, right) => right.eventId - left.eventId);
        const pages = Math.max(1, Math.ceil(events.length / INBOX_PAGE_SIZE));
        page = Math.min(page, pages);
        const start = (page - 1) * INBOX_PAGE_SIZE;
        const labels = new Map<string, StoredEvent>();
        for (const event of events.slice(start, start + INBOX_PAGE_SIZE)) {
          labels.set(formatEventLabel(event), event);
        }
        const navigation = [
          ...(page > 1 ? [INBOX_PREV] : []),
          ...(page < pages ? [INBOX_NEXT] : []),
        ];
        const title =
          pages > 1
            ? `Knot 收件箱（未读 ${store.unreadCount()} / 共 ${events.length} 条，第 ${page}/${pages} 页）`
            : `Knot 收件箱（未读 ${store.unreadCount()} / 共 ${events.length} 条）`;
        const choice = await ctx.ui.select(title, [...labels.keys(), ...navigation]);
        // 等待选择框期间可能发生 /reload、/new 或退出：旧 runtime 不得再弹通知。
        if (this.disposed) {
          return;
        }
        if (!choice) {
          // 取消即结束，不做任何隐式 read。
          return;
        }
        if (choice === INBOX_NEXT) {
          page += 1;
          continue;
        }
        if (choice === INBOX_PREV) {
          page -= 1;
          continue;
        }
        const event = labels.get(choice);
        if (!event) {
          return;
        }
        // 详情只是展示；read 仍然必须由用户显式执行。
        this.notify(formatEventDetail(event, (this.config as KnotConfig).agentSessionId), "info");
        return;
      }
    } finally {
      this.endCommand();
    }
  }

  /**
   * 显式阅读入口：只发定位信息，且只在用户显式 read 时调用。
   * 自动处理走 maybeDispatchAuto；read 始终只是查看，不授权执行。
   */
  private readEvent(rawId: string | undefined): void {
    if (!this.isInteractive()) {
      return;
    }
    const eventId = Number(rawId);
    if (!rawId || !Number.isSafeInteger(eventId) || eventId <= 0) {
      this.notify("用法：/knot read <event_id>（先 /knot inbox 查看）", "warning");
      return;
    }
    const problem = this.beginCommand();
    if (problem) {
      this.notify(problem, "error");
      return;
    }
    try {
      const store = this.store as StateStore;
      const event = store.find(eventId);
      if (!event) {
        this.notify(`收件箱里没有 event_id ${eventId}（可能属于其他 Knot 会话或尚未收到）`, "warning");
        return;
      }
      try {
        this.pi.sendMessage(
          {
            customType: "knot-event",
            content: [{ type: "text", text: buildReadMessage(event, (this.config as KnotConfig).agentSessionId) }],
            display: true,
            details: {
              eventId: event.eventId,
              type: event.type,
              roomId: event.roomId,
              messageId: event.messageId,
              seq: event.seq,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch (error) {
        this.notify(`发送定位信息失败：${errorText(error)}`, "error");
        return;
      }
      let readMarkFailed = false;
      try {
        store.markRead(event.eventId);
      } catch (error) {
        readMarkFailed = true;
        this.notify(`已交给模型，但已读标记未保存：${errorText(error)}`, "warning");
      }
      this.renderStatus();
      if (!readMarkFailed) {
        this.notify(
          `已把 event ${event.eventId} 的定位信息交给当前会话（可见消息）；read 只请求阅读，不授权执行`,
          "info",
        );
      }
    } finally {
      this.endCommand();
    }
  }

  private showStatus(): void {
    const lines: string[] = [];
    if (!this.config) {
      lines.push(this.configProblem ?? "Knot 未配置");
      lines.push(`配置文件：${joinAgentConfigPath()}`);
      this.notify(lines.join("\n"), "info");
      return;
    }
    const state = this.configProblem
      ? "收件箱不可用"
      : this.client
        ? statusWord(this.client.status)
        : this.stoppedByUser
          ? "已断开（手动）"
          : this.bindingProblem
            ? "绑定冲突"
            : this.stateProblem
              ? "状态不可写"
              : this.lockProblem
                ? "锁被占用"
                : "未连接";
    lines.push(`状态：${state}`);
    lines.push(`Knot 会话：${this.config.agentSessionId}　服务：${this.config.restBase}`);
    lines.push(
      `凭证来源：${
        this.config.tokenSource === "env"
          ? "环境变量 KNOT_AGENT_TOKEN"
          : "用户级 mcp.json（mcpServers.knot 的 Bearer）"
      }`,
    );
    if (this.store) {
      lines.push(`自动处理：${this.autoSummary(this.store)}`);
    }
    if (this.store) {
      lines.push(`游标：${this.store.cursor}　未读：${this.store.unreadCount()}　收件箱：${this.store.events.length} 条`);
    }
    if (this.client?.lastError) {
      lines.push(`最近错误：${this.client.lastError}`);
    }
    if (this.client?.retryDelayMs !== undefined) {
      lines.push(`下次重试：约 ${(this.client.retryDelayMs / 1000).toFixed(1)}s`);
    }
    if (this.bindingProblem) {
      lines.push(this.bindingProblem);
    }
    if (this.stateProblem) {
      lines.push(this.stateProblem);
    }
    if (this.lockProblem) {
      lines.push(this.lockProblem);
    }
    if (this.configProblem) {
      lines.push(this.configProblem);
    }
    if (this.warnings.length > 0) {
      lines.push(`提示：${this.warnings.join("；")}`);
    }
    lines.push(`配置文件：${this.config.configFile}`);
    lines.push(`绑定：${bindingPath(this.config.stateDir)}`);
    this.notify(
      lines.join("\n"),
      this.configProblem || this.lockProblem || this.bindingProblem || this.stateProblem ? "warning" : "info",
    );
  }

  /**
   * 命令需要读写收件箱：拿不到锁就只报错，不接管别人的连接。
   * 同时校验“本 Pi 会话确实是该 Knot 会话的绑定所有者”，绝不替别的会话建立绑定。
   */
  private beginCommand(): string | undefined {
    if (!this.isInteractive()) {
      return "Knot 收件箱与 read 只在交互模式（tui）可用";
    }
    if (!this.config || !this.store) {
      this.load();
    }
    if (!this.config || !this.store) {
      return this.configProblem ?? "Knot 未配置";
    }
    const lockProblem = this.ensureLock();
    if (lockProblem) {
      return lockProblem;
    }
    try {
      requireBinding({
        dataDir: this.config.dataDir,
        stateDir: this.config.stateDir,
        serviceKey: this.config.serviceKey,
        agentSessionId: this.config.agentSessionId,
        piSessionId: this.piSessionId,
      });
    } catch (error) {
      this.endCommand();
      return errorText(error);
    }
    return undefined;
  }

  private endCommand(): void {
    if (this.lockTransient) {
      this.releaseLock();
    }
  }

  private ensureLock(): string | undefined {
    if (this.lock) {
      return undefined;
    }
    const config = this.config as KnotConfig;
    let lock: StateLock;
    try {
      const result = acquireStateLock(config.stateDir, this.piSessionId);
      if (!result.ok) {
        const holder = result.holder;
        return (
          `Knot 本地锁被占用${holder ? `（pid ${holder.pid}，Pi 会话 ${shortId(holder.piSessionId)}）` : ""}；` +
          `确认没有其他 Pi 进程在使用该 Knot 会话后，可手工删除 ${lockPath(config.stateDir)}`
        );
      }
      lock = result.lock;
    } catch (error) {
      return `Knot 本地锁创建失败：${errorText(error)}`;
    }
    this.lock = lock;
    this.lockTransient = true;
    try {
      this.store?.reload();
    } catch (error) {
      this.releaseLock();
      return errorText(error);
    }
    return undefined;
  }

  private releaseLock(): void {
    try {
      this.lock?.release();
    } catch {
      // 忽略：锁目录可能已被手工删除。
    }
    this.lock = undefined;
    this.lockTransient = false;
  }

  private renderStatus(): void {
    try {
      this.ctx.ui.setStatus(STATUS_KEY, this.redact(this.statusText()));
    } catch {
      // 旧 ctx 在 /reload 后失效；忽略。
    }
  }

  private statusText(): string {
    if (!this.config) {
      return "knot · 未配置";
    }
    const state = this.configProblem
      ? "收件箱不可用"
      : this.client
        ? statusWord(this.client.status)
        : this.stoppedByUser
          ? "已断开"
          : this.bindingProblem
            ? "绑定冲突"
            : this.stateProblem
              ? "状态不可写"
              : this.lockProblem
                ? "锁被占用"
                : "未连接";
    const auto = this.config.autoExecuteMentions
      ? ` · 自动${this.store?.auto?.armed ? "开" : "待基线"}`
      : "";
    return `knot · ${state} · 会话 ${this.config.agentSessionId} · 未读 ${this.store?.unreadCount() ?? 0}${auto}`;
  }

  /** ready 校验通过（同步回调）：自动处理在首次启用时以该水位建立“未来-only”起点。 */
  private onRelayReady(latestEventId: number | undefined): void {
    const config = this.config;
    const store = this.store;
    if (this.disposed || !config?.autoExecuteMentions || !store || store.auto?.armed) {
      return;
    }
    if (latestEventId === undefined) {
      this.notify("无法建立 Knot 自动处理起点（ready 未给出 latest_event_id），自动处理保持关闭", "warning");
      return;
    }
    try {
      const state: AutoState = { armed: true, baseline: latestEventId, armedAt: Date.now() };
      store.setAuto(state);
    } catch (error) {
      this.notify(`无法保存 Knot 自动处理起点：${errorText(error)}；自动处理保持关闭`, "error");
      return;
    }
    this.renderStatus();
    this.notify(
      `Knot 自动处理就绪：起点 event ${latestEventId}（历史不执行），之后主人直接 @ 或已审批的 mention.execute 会送交当前会话`,
      "info",
    );
    this.maybeDispatchAuto();
  }

  /** 真正的 agent_settled 才解除“等待本轮结束”的闸门，并考虑下一条。 */
  onAgentSettled(ctx: ExtensionContext): void {
    if (this.disposed || !this.matches(ctx)) {
      return;
    }
    this.awaitingSettle = false;
    this.maybeDispatchAuto();
  }

  /**
   * 自动投递入口：只有“启用 + 已建立基线 + 结构化 mention.execute + 晚于基线 + 从未投递”
   * 才会把定位信息送交当前会话。任何一步不满足都保持沉默（notify-only）。
   */
  private maybeDispatchAuto(): void {
    const config = this.config;
    const store = this.store;
    if (this.dispatching || this.awaitingSettle || this.disposed || !config?.autoExecuteMentions || !store) {
      return;
    }
    if (!this.isInteractive() || !this.client || this.stoppedByUser) {
      return;
    }
    // 只在真正 connected（补拉完成）时投递：fatal/重试/断开时不执行旧 pending。
    if (this.client.status !== "connected") {
      return;
    }
    if (this.bindingProblem || this.configProblem || this.stateProblem || !this.lock) {
      return;
    }
    const auto = store.auto;
    if (!auto?.armed) {
      return;
    }
    if (!this.ctx.isIdle()) {
      // 正在跑一轮：等 agent_settled 再来，避免把多条请求堆进同一轮。
      return;
    }
    const event = store.pendingAutoEvents(auto.baseline)[0];
    if (!event) {
      return;
    }
    this.dispatching = true;
    try {
      if (!store.beginDispatch(event.eventId)) {
        return;
      }
    } catch (error) {
      this.dispatching = false;
      this.notify(`自动投递未执行：无法保存投递状态（${errorText(error)}）`, "error");
      return;
    }
    let delivered = false;
    let failure = "";
    try {
      this.pi.sendMessage(
        {
          customType: "knot-auto-mention",
          content: [
            { type: "text", text: buildAutoExecuteMessage(event, config.agentSessionId) },
          ],
          display: true,
          details: {
            eventId: event.eventId,
            type: event.type,
            roomId: event.roomId,
            messageId: event.messageId,
            seq: event.seq,
            mentionId: event.mentionId,
            auto: true,
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      delivered = true;
    } catch (error) {
      failure = errorText(error);
    }
    if (delivered) {
      // 已经交给宿主：在真正 agent_settled 之前不再投递下一条。
      this.awaitingSettle = true;
    }
    try {
      store.finishDispatch(event.eventId, delivered);
    } catch (error) {
      this.notify(
        `Knot 事件 ${event.eventId} 的投递状态未保存（${errorText(error)}）；重启后不会自动重发，请人工确认`,
        "error",
      );
    }
    this.dispatching = false;
    this.renderStatus();
    if (delivered) {
      this.notify(
        `已自动投递 Knot 事件 ${event.eventId}（主人直接 @ 或已审批的 mention.execute，room ${event.roomId}）到当前会话`,
        "info",
      );
    } else {
      this.notify(`自动投递 Knot 事件 ${event.eventId} 失败：${failure}`, "error");
    }
  }

  private autoSummary(store: StateStore): string {
    if (!this.config?.autoExecuteMentions) {
      return "关闭（notify-only）";
    }
    const auto = store.auto;
    if (!auto?.armed) {
      return "待基线（连接并收到 ready 后建立起点）";
    }
    if (this.awaitingSettle) {
      return `已就绪（起点 event ${auto.baseline}，等待本轮结束后继续；已投递 ${store.dispatchedCount()} 条）`;
    }
    return `已就绪（起点 event ${auto.baseline}，已投递 ${store.dispatchedCount()} 条）`;
  }

  private noteEvents(added: number): void {
    this.pendingNotice += added;
    // 事件已经落盘：可以立刻考虑自动投递（仍受 isIdle/基线/开关约束）。
    this.maybeDispatchAuto();
    if (this.noticeTimer) {
      return;
    }
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      const count = this.pendingNotice;
      this.pendingNotice = 0;
      if (count <= 0 || this.disposed) {
        return;
      }
      this.notify(
        `收到 ${count} 条 Knot 事件（未读 ${this.store?.unreadCount() ?? 0}），用 /knot inbox 查看`,
        "info",
      );
    }, NOTIFY_DELAY_MS);
    this.noticeTimer.unref?.();
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    this.pendingNotice = 0;
  }

  private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    // 只有 TUI 会弹通知：rpc/json/print 一律静默，避免非交互模式出现交互框。
    if (!this.isInteractive()) {
      return;
    }
    try {
      this.ctx.ui.notify(this.redact(message), type);
    } catch {
      // UI 不可用时不阻塞连接。
    }
  }
}

function statusWord(status: ClientStatus): string {
  switch (status) {
    case "idle":
      return "未连接";
    case "connecting":
      return "连接中";
    case "catching-up":
      return "补拉中";
    case "connected":
      return "已连接";
    case "retrying":
      return "重试中";
    case "stopped":
      return "已停止";
  }
}

function joinAgentConfigPath(): string {
  return join(resolveAgentDir(), "knot.json");
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "未知错误";
}
