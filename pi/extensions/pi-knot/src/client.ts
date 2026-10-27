/**
 * 单条 WebSocket 连接 + REST 补拉的状态机。
 *
 * 关键约束：
 * - 收到 ready 之后才补拉；ready.latest_event_id 只当发送水位，绝不写成已处理游标；
 * - 补拉期间实时帧进有界缓存，补拉成功后按 event_id 合并、排序、去重；
 * - 心跳处理是同步的（立即回 pong），REST 请求异步进行，不会阻塞心跳；
 * - 每次连接（attempt）都有自己的 epoch：一旦结束，它的 socket、取消控制器、
 *   缓存和所有 await 之后的续体都失效，绝不会把旧页写进新连接的状态；
 * - 4401/4403/4409 与握手阶段的权限/重定向错误停止自动重试；
 * - 落盘失败立即中止本轮连接，不推进游标，靠下一轮按持久游标补拉。
 */
import WebSocket, { type ClientOptions } from "ws";
import type { KnotConfig } from "./config.ts";
import { cleanText } from "./format.ts";
import { KNOT_EVENT_TYPES, type KnotEventType, type StateStore, type StoredEvent } from "./store.ts";

export interface Timings {
  handshakeMs: number;
  readyMs: number;
  silenceMs: number;
  requestMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  bufferLimit: number;
  pageSize: number;
}

export const DEFAULT_TIMINGS: Timings = {
  handshakeMs: 15_000,
  readyMs: 20_000,
  silenceMs: 45_000,
  requestMs: 15_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  bufferLimit: 512,
  pageSize: 100,
};

export interface WsLike {
  on(event: string, handler: (...args: never[]) => void): unknown;
  send(data: string): void;
  terminate(): void;
  removeAllListeners(): unknown;
}

export type WsFactory = (url: string, options: Record<string, unknown>) => WsLike;

export type ClientStatus = "idle" | "connecting" | "catching-up" | "connected" | "retrying" | "stopped";

export interface KnotClientDeps {
  config: KnotConfig;
  store: StateStore;
  onChange?: () => void;
  onEvents?: (added: number) => void;
  /** ready 校验通过后同步回调：latest_event_id 只用于建立自动处理起点。 */
  onReady?: (info: { latestEventId: number | undefined }) => void;
  createSocket?: WsFactory;
  fetchImpl?: typeof fetch;
  timings?: Partial<Timings>;
  random?: () => number;
  now?: () => number;
}

type Outcome =
  | { kind: "transient"; text: string }
  | { kind: "fatal"; text: string }
  | { kind: "stopped" };

/** 可重试的错误（网络、超时、5xx、响应格式暂时不对）。 */
class AttemptError extends Error {}

/** 不可重试的错误（重定向、凭证/权限、会话不存在）。 */
class FatalAttemptError extends Error {}

/** 业务帧或补拉内容不符合协议。 */
class ProtocolViolation extends Error {}

interface EventPage {
  events: StoredEvent[];
  hasMore: boolean;
}

/**
 * 一次连接尝试的全部可变状态。它不挂在 client 上共享：
 * 旧 attempt 的迟到回调只能看到自己的对象，isLive() 为 false 时直接返回。
 */
interface Attempt {
  readonly generation: number;
  readonly epoch: number;
  readonly startedAt: number;
  settled: boolean;
  readySeen: boolean;
  catchingUp: boolean;
  caughtUp: boolean;
  buffer: Map<number, StoredEvent>;
  socket?: WsLike;
  abort?: AbortController;
  requestTimer?: ReturnType<typeof setTimeout>;
  readyTimer?: ReturnType<typeof setTimeout>;
  silenceTimer?: ReturnType<typeof setTimeout>;
  errorTimer?: ReturnType<typeof setTimeout>;
  settle?: (outcome: Outcome) => void;
  protocolText?: string;
  httpText?: string;
}

const MAX_PAGES = 10_000;
const SENDER_KINDS = new Set(["human", "agent_session", "agent"]);

export class KnotClient {
  status: ClientStatus = "idle";
  lastError?: string;
  retryDelayMs?: number;

  private readonly timings: Timings;
  private readonly deps: KnotClientDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;
  private readonly now: () => number;

  private generation = 0;
  private epoch = 0;
  private stopped = true;
  private current?: Attempt;
  private wakeSleep?: () => void;
  private sleepTimer?: ReturnType<typeof setTimeout>;
  private backoff: number;

  constructor(deps: KnotClientDeps) {
    this.deps = deps;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.backoff = this.timings.backoffBaseMs;
  }

  /** 仍在工作（连接/补拉/退避重试）；停止或致命错误后为 false。 */
  get running(): boolean {
    return !this.stopped && this.status !== "stopped";
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.lastError = undefined;
    this.backoff = this.timings.backoffBaseMs;
    const generation = ++this.generation;
    void this.loop(generation);
  }

  /** 同步、幂等：当前 attempt 立即失效，然后清定时器、取消请求、断开 socket。 */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.generation += 1;
    const current = this.current;
    this.current = undefined;
    if (current) {
      current.settled = true;
      this.cleanupAttempt(current);
      current.settle?.({ kind: "stopped" });
    }
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    this.wakeSleep?.();
    this.status = "idle";
    this.retryDelayMs = undefined;
    this.changed();
  }

  private async loop(generation: number): Promise<void> {
    let attempts = 0;
    while (this.active(generation)) {
      if (attempts > 0) {
        const delay = this.nextDelay();
        this.retryDelayMs = delay;
        this.setStatus("retrying");
        this.changed();
        await this.sleep(delay);
        if (!this.active(generation)) {
          return;
        }
        this.retryDelayMs = undefined;
        this.backoff = Math.min(this.timings.backoffMaxMs, this.backoff * 2);
      }
      attempts += 1;
      const attempt = this.createAttempt(generation);
      this.current = attempt;
      const outcome = await this.runAttempt(attempt);
      if (!this.active(generation)) {
        return;
      }
      if (outcome.kind === "stopped") {
        return;
      }
      if (outcome.kind === "fatal") {
        this.lastError = outcome.text;
        this.retryDelayMs = undefined;
        this.setStatus("stopped");
        this.changed();
        return;
      }
      this.lastError = outcome.text;
      // 只有“补拉成功且连接存活过一小段时间”才重置退避，避免抖动式热循环。
      if (attempt.caughtUp && this.now() - attempt.startedAt >= this.timings.backoffBaseMs * 5) {
        this.backoff = this.timings.backoffBaseMs;
      }
      this.changed();
    }
  }

  private nextDelay(): number {
    const jittered = this.backoff * (0.8 + this.random() * 0.4);
    return Math.min(this.timings.backoffMaxMs, Math.max(1, Math.round(jittered)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepTimer = undefined;
        this.wakeSleep = undefined;
        resolve();
      }, ms);
      timer.unref?.();
      this.sleepTimer = timer;
      this.wakeSleep = () => {
        clearTimeout(this.sleepTimer);
        this.sleepTimer = undefined;
        this.wakeSleep = undefined;
        resolve();
      };
    });
  }

  private createAttempt(generation: number): Attempt {
    return {
      generation,
      epoch: ++this.epoch,
      startedAt: this.now(),
      settled: false,
      readySeen: false,
      catchingUp: true,
      caughtUp: false,
      buffer: new Map(),
    };
  }

  private async runAttempt(attempt: Attempt): Promise<Outcome> {
    this.setStatus("connecting");

    let socket: WsLike;
    try {
      socket = this.createSocket(this.deps.config.wsUrl, {
        headers: { Authorization: `Bearer ${this.deps.config.token}` },
        handshakeTimeout: this.timings.handshakeMs,
        followRedirects: false,
        maxPayload: 2 * 1024 * 1024,
      });
    } catch (error) {
      return {
        kind: "transient",
        text: `无法建立 WebSocket（${safeErrorCode(error) ?? "未知错误"}），将退避重试`,
      };
    }
    attempt.socket = socket;
    if (!this.isLive(attempt)) {
      this.cleanupAttempt(attempt);
      return { kind: "stopped" };
    }

    return new Promise<Outcome>((resolve) => {
      let settled = false;
      let errorCode: string | undefined;

      const finish = (outcome: Outcome) => {
        if (settled) {
          return;
        }
        settled = true;
        attempt.settled = true;
        if (this.current === attempt) {
          this.current = undefined;
        }
        this.cleanupAttempt(attempt);
        resolve(outcome);
      };
      attempt.settle = finish;

      socket.on("open", () => {
        if (!this.isLive(attempt)) {
          return;
        }
        this.armReadyTimer(attempt);
        this.changed();
      });
      socket.on("message", (data: unknown) => this.onFrame(attempt, data));
      socket.on("error", (error: unknown) => {
        errorCode = safeErrorCode(error);
        // 握手失败时 ws 随后会发 close；这里兜底，避免永远等待。
        // 定时器挂在 attempt 上：stop/shutdown 时一定被清掉，且同一 attempt 不重复创建。
        if (attempt.errorTimer) {
          return;
        }
        const fallback = setTimeout(() => {
          attempt.errorTimer = undefined;
          finish(this.classifyClose(attempt, 1006, errorCode));
        }, 500);
        fallback.unref?.();
        attempt.errorTimer = fallback;
      });
      socket.on("close", (code: unknown) => {
        finish(this.classifyClose(attempt, typeof code === "number" ? code : 1006, errorCode));
      });
      socket.on("unexpected-response", (request: unknown, response: unknown) => {
        const status = responseStatus(response);
        attempt.httpText = httpFatalText(status);
        try {
          (request as unknown as { destroy?: () => void }).destroy?.();
        } catch {
          // 忽略：请求已结束。
        }
        finish(
          attempt.httpText
            ? { kind: "fatal", text: attempt.httpText }
            : { kind: "transient", text: `WebSocket 握手失败（HTTP ${status}），将退避重试` },
        );
      });
    });
  }

  private createSocket(url: string, options: Record<string, unknown>): WsLike {
    if (this.deps.createSocket) {
      return this.deps.createSocket(url, options);
    }
    return new WebSocket(url, options as ClientOptions) as unknown as WsLike;
  }

  private onFrame(attempt: Attempt, data: unknown): void {
    if (!this.isLive(attempt)) {
      return;
    }
    if (attempt.silenceTimer) {
      clearTimeout(attempt.silenceTimer);
      attempt.silenceTimer = undefined;
    }
    this.armSilence(attempt);

    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      this.failProtocol(attempt, "收到无法解析的 WebSocket 帧，已停止以避免跳过事件");
      return;
    }
    if (!isRecord(frame)) {
      this.failProtocol(attempt, "收到格式错误的 WebSocket 帧，已停止以避免跳过事件");
      return;
    }
    switch (frame.type) {
      case "heartbeat":
        this.sendPong(attempt);
        return;
      case "ready":
        this.onReady(attempt, frame);
        return;
      case "room.message":
      case "mention.pending":
      case "mention.execute":
        this.onEventFrame(attempt, frame);
        return;
      default:
        this.failProtocol(attempt, "收到未知的 WebSocket 帧类型，已停止以避免跳过事件");
    }
  }

  private sendPong(attempt: Attempt): void {
    try {
      attempt.socket?.send('{"type":"pong"}');
    } catch {
      // 连接已断；close 事件会走重连。
    }
  }

  private onReady(attempt: Attempt, frame: Record<string, unknown>): void {
    if (attempt.readySeen) {
      this.failProtocol(attempt, "服务端重复发送 ready，已停止");
      return;
    }
    if (frame.agent_session_id !== this.deps.config.agentSessionId) {
      this.failProtocol(attempt, "ready 中的会话 ID 与配置不一致，已停止");
      return;
    }
    attempt.readySeen = true;
    if (attempt.readyTimer) {
      clearTimeout(attempt.readyTimer);
      attempt.readyTimer = undefined;
    }
    this.armSilence(attempt);
    // latest_event_id 只是水位，绝不写进 processed cursor；交由运行时决定是否用它建立基线。
    const watermark = frame.latest_event_id;
    try {
      this.deps.onReady?.({
        latestEventId:
          typeof watermark === "number" && Number.isSafeInteger(watermark) && watermark >= 0
            ? watermark
            : undefined,
      });
    } catch {
      // 基线写入失败由运行时提示，不影响补拉。
    }
    this.setStatus("catching-up");
    this.changed();
    void this.catchUp(attempt);
  }

  private onEventFrame(attempt: Attempt, frame: Record<string, unknown>): void {
    let event: StoredEvent;
    try {
      event = parseEvent(frame, {
        agentSessionId: this.deps.config.agentSessionId,
        token: this.deps.config.token,
      });
    } catch (error) {
      this.failProtocol(
        attempt,
        `事件帧无效（${error instanceof ProtocolViolation ? error.message : "字段不符合协议"}），已停止以避免跳过事件`,
      );
      return;
    }
    if (event.eventId <= this.deps.store.cursor) {
      return;
    }
    if (attempt.catchingUp || attempt.buffer.size > 0) {
      if (attempt.buffer.size >= this.timings.bufferLimit) {
        this.abortAttempt(attempt, `实时事件缓存超过 ${this.timings.bufferLimit} 条，已断开并按游标补拉`);
        return;
      }
      attempt.buffer.set(event.eventId, event);
      return;
    }
    try {
      this.commit(attempt, [event]);
      this.changed();
    } catch (error) {
      this.abortAttempt(attempt, describeError(error));
    }
  }

  private async catchUp(attempt: Attempt): Promise<void> {
    try {
      let pages = 0;
      while (this.isLive(attempt)) {
        pages += 1;
        if (pages > MAX_PAGES) {
          throw new AttemptError("补拉分页数超过上限，已停止本轮补拉");
        }
        const afterId = this.deps.store.cursor;
        const page = await this.fetchPage(attempt, afterId);
        if (!page || !this.isLive(attempt)) {
          return;
        }
        const fresh = page.events.filter((event) => event.eventId > this.deps.store.cursor);
        if (fresh.length > 0) {
          this.commit(attempt, fresh);
        }
        if (!page.hasMore) {
          break;
        }
        if (page.events.length === 0 || this.deps.store.cursor <= afterId) {
          // 服务端说还有更多，但这一页没有任何进展：不能进入实时态，
          // 否则游标之后的中间事件会被永久跳过。失败关闭，按持久游标重试。
          throw new AttemptError("补拉返回 has_more=true 但没有推进游标，已停止本轮补拉以免跳过事件");
        }
      }
      if (!this.isLive(attempt)) {
        return;
      }
      this.drainBuffer(attempt);
      if (!this.isLive(attempt)) {
        return;
      }
      attempt.catchingUp = false;
      attempt.caughtUp = true;
      this.lastError = undefined;
      this.retryDelayMs = undefined;
      this.setStatus("connected");
      this.changed();
    } catch (error) {
      if (!this.isLive(attempt)) {
        return;
      }
      const text = describeError(error);
      this.lastError = text;
      this.changed();
      this.abortAttempt(attempt, text, error instanceof FatalAttemptError);
    }
  }

  private drainBuffer(attempt: Attempt): void {
    const ids = [...attempt.buffer.keys()].sort((left, right) => left - right);
    if (ids.length === 0) {
      return;
    }
    const pending = ids
      .map((id) => attempt.buffer.get(id))
      .filter((event): event is StoredEvent => event !== undefined && event.eventId > this.deps.store.cursor);
    if (pending.length > 0) {
      this.commit(attempt, pending);
    }
    for (const id of ids) {
      attempt.buffer.delete(id);
    }
  }

  private commit(attempt: Attempt, events: readonly StoredEvent[]): number {
    if (!this.isLive(attempt)) {
      return 0;
    }
    let added = 0;
    try {
      added = this.deps.store.commitEvents(events);
    } catch (error) {
      throw new AttemptError(
        `本地收件箱写入失败（${safeErrorCode(error) ?? "I/O 错误"}），已停止本轮连接以免跳过事件`,
      );
    }
    if (added > 0) {
      try {
        this.deps.onEvents?.(added);
      } catch {
        // 通知失败不影响收件箱。
      }
    }
    return added;
  }

  private async fetchPage(attempt: Attempt, afterId: number): Promise<EventPage | undefined> {
    const url = new URL(`${this.deps.config.restBase}/api/agent-events`);
    url.searchParams.set("agent_session_id", String(this.deps.config.agentSessionId));
    url.searchParams.set("after_id", String(afterId));
    url.searchParams.set("limit", String(this.timings.pageSize));

    const controller = new AbortController();
    attempt.abort = controller;
    const timer = setTimeout(() => {
      // 超时由计时器结束本次 attempt，而不是等 fetch 自己拒绝：
      // 底层 fetch 是否响应 AbortSignal 不是正确性/活性保证。
      controller.abort();
      if (!this.isLive(attempt)) {
        return;
      }
      this.abortAttempt(attempt, "补拉请求超时或被取消，将退避重试");
    }, this.timings.requestMs);
    timer.unref?.();
    attempt.requestTimer = timer;
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${this.deps.config.token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!this.isLive(attempt)) {
        return undefined;
      }
      if (response.status >= 300 && response.status < 400) {
        throw new FatalAttemptError("补拉请求被重定向（HTTP 3xx）：为避免凭证泄露，已拒绝跟随");
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new FatalAttemptError(
          `补拉请求被拒绝（HTTP ${response.status}）：请检查 KNOT_AGENT_TOKEN 与 Knot 会话 ID`,
        );
      }
      if (!response.ok) {
        throw new AttemptError(`补拉请求失败（HTTP ${response.status}），将退避重试`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (!this.isLive(attempt)) {
          return undefined;
        }
        throw new AttemptError("补拉响应不是合法 JSON，将退避重试");
      }
      // fetch 取消不是正确性保证：响应体可能在 attempt 结束后才解析完成。
      if (!this.isLive(attempt)) {
        return undefined;
      }
      return parsePage(body, {
        agentSessionId: this.deps.config.agentSessionId,
        token: this.deps.config.token,
      });
    } catch (error) {
      if (!this.isLive(attempt)) {
        return undefined;
      }
      if (error instanceof FatalAttemptError || error instanceof AttemptError) {
        throw error;
      }
      if (error instanceof ProtocolViolation) {
        throw new AttemptError(`补拉响应不符合协议（${error.message}），将退避重试`);
      }
      if (isAbortError(error)) {
        throw new AttemptError("补拉请求超时或被取消，将退避重试");
      }
      throw new AttemptError(`补拉请求失败（${safeErrorCode(error) ?? "网络错误"}），将退避重试`);
    } finally {
      clearTimeout(timer);
      if (attempt.requestTimer === timer) {
        attempt.requestTimer = undefined;
      }
      if (attempt.abort === controller) {
        attempt.abort = undefined;
      }
    }
  }

  private armReadyTimer(attempt: Attempt): void {
    if (attempt.readyTimer) {
      clearTimeout(attempt.readyTimer);
      attempt.readyTimer = undefined;
    }
    const timer = setTimeout(() => {
      attempt.readyTimer = undefined;
      if (!this.isLive(attempt)) {
        return;
      }
      this.abortAttempt(attempt, "服务端未在限定时间内发送 ready，已断开重连");
    }, this.timings.readyMs);
    timer.unref?.();
    attempt.readyTimer = timer;
  }

  private armSilence(attempt: Attempt): void {
    if (attempt.silenceTimer) {
      clearTimeout(attempt.silenceTimer);
      attempt.silenceTimer = undefined;
    }
    const timer = setTimeout(() => {
      attempt.silenceTimer = undefined;
      if (!this.isLive(attempt)) {
        return;
      }
      this.abortAttempt(attempt, "长时间未收到 Knot 心跳，已断开重连");
    }, this.timings.silenceMs);
    timer.unref?.();
    attempt.silenceTimer = timer;
  }

  private abortAttempt(attempt: Attempt, text: string, fatal = false): void {
    if (!this.isLive(attempt)) {
      return;
    }
    this.lastError = text;
    this.changed();
    attempt.settle?.(fatal ? { kind: "fatal", text } : { kind: "transient", text });
  }

  private failProtocol(attempt: Attempt, text: string): void {
    attempt.protocolText = text;
    this.abortAttempt(attempt, text, true);
  }

  private classifyClose(attempt: Attempt, code: number, errorCode: string | undefined): Outcome {
    if (attempt.protocolText) {
      return { kind: "fatal", text: attempt.protocolText };
    }
    if (attempt.httpText) {
      return { kind: "fatal", text: attempt.httpText };
    }
    switch (code) {
      case 4401:
        return {
          kind: "fatal",
          text: "Knot 拒绝凭证（4401）：Token 无效、已撤销或 owner 被禁用；请更新 KNOT_AGENT_TOKEN 后重试",
        };
      case 4403:
        return {
          kind: "fatal",
          text: "Knot 拒绝该会话（4403）：会话不属于该 Agent 或不存在；请检查 KNOT_AGENT_SESSION_ID",
        };
      case 4409:
        return {
          kind: "fatal",
          text: "该 Knot 会话已有其他客户端连接（4409）：不会自动重试，请先关闭另一个客户端",
        };
      case 4408:
        return { kind: "transient", text: "Knot 心跳超时或服务端断开（4408），将退避重连并补拉" };
      case 1011:
        return { kind: "transient", text: "Knot 服务端内部错误（1011），将退避重连" };
      case 1006:
        return {
          kind: "transient",
          text: `WebSocket 连接中断${errorCode ? `（${errorCode}）` : ""}，将退避重连`,
        };
      default:
        return { kind: "transient", text: `WebSocket 已关闭（${code}），将退避重连` };
    }
  }

  /** attempt 仍然属于当前 generation 且未被结束。所有异步续体都要先过这一关。 */
  private isLive(attempt: Attempt): boolean {
    return (
      !this.stopped &&
      !attempt.settled &&
      attempt.generation === this.generation &&
      this.current === attempt
    );
  }

  private active(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private cleanupAttempt(attempt: Attempt): void {
    if (attempt.errorTimer) {
      clearTimeout(attempt.errorTimer);
      attempt.errorTimer = undefined;
    }
    if (attempt.readyTimer) {
      clearTimeout(attempt.readyTimer);
      attempt.readyTimer = undefined;
    }
    if (attempt.silenceTimer) {
      clearTimeout(attempt.silenceTimer);
      attempt.silenceTimer = undefined;
    }
    if (attempt.requestTimer) {
      clearTimeout(attempt.requestTimer);
      attempt.requestTimer = undefined;
    }
    try {
      attempt.abort?.abort();
    } catch {
      // 忽略。
    }
    attempt.abort = undefined;
    const socket = attempt.socket;
    attempt.socket = undefined;
    if (!socket) {
      return;
    }
    try {
      socket.removeAllListeners();
    } catch {
      // 忽略：ws 已销毁。
    }
    try {
      // terminate() 在握手阶段会异步 emit "error"；没有监听器时会变成未捕获异常。
      socket.on("error", () => {});
    } catch {
      // 忽略。
    }
    try {
      socket.terminate();
    } catch {
      // 忽略：ws 已关闭。
    }
  }

  private setStatus(status: ClientStatus): void {
    this.status = status;
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // UI 回调失败不影响连接。
    }
  }
}

export function parsePage(body: unknown, expected: { agentSessionId: number; token: string }): EventPage {
  if (!isRecord(body) || !Array.isArray(body.events) || typeof body.has_more !== "boolean") {
    throw new ProtocolViolation("缺少 events 数组或 has_more 布尔值");
  }
  const events = body.events.map((item) => parseEvent(item, expected));
  return { events, hasMore: body.has_more };
}

/**
 * 只保留协议白名单字段：外部字段一律丢弃，summary/发送者名字去掉控制字符并截断，
 * 同时抹掉可能被服务端回显的 Token。
 *
 * `sender.kind` 只接受协议枚举；`message_version` 必须保持语义完整，因此一旦命中
 * 凭证内容就拒绝整条事件（不推进游标），而不是把字段改写后继续。
 */
export function parseEvent(raw: unknown, expected: { agentSessionId: number; token: string }): StoredEvent {
  if (!isRecord(raw)) {
    throw new ProtocolViolation("事件不是 JSON 对象");
  }
  const type: KnotEventType | undefined = KNOT_EVENT_TYPES.find((candidate) => candidate === raw.type);
  if (!type) {
    throw new ProtocolViolation("事件类型未知");
  }
  const eventId = positiveInt(raw.event_id, "event_id");
  if (positiveInt(raw.agent_session_id, "agent_session_id") !== expected.agentSessionId) {
    throw new ProtocolViolation("事件的会话 ID 与配置不一致");
  }
  if (!isRecord(raw.sender)) {
    throw new ProtocolViolation("事件缺少 sender");
  }
  const event: StoredEvent = {
    eventId,
    type,
    roomId: positiveInt(raw.room_id, "room_id"),
    messageId: positiveInt(raw.message_id, "message_id"),
    seq: nonNegativeInt(raw.seq, "seq"),
    senderKind:
      typeof raw.sender.kind === "string" && SENDER_KINDS.has(raw.sender.kind) ? raw.sender.kind : "unknown",
    senderId: nonNegativeInt(raw.sender.id, "sender.id"),
    senderName: cleanText(raw.sender.name, 100, expected.token),
    summary: cleanText(raw.summary, 500, expected.token),
    createdAt: nonNegativeInt(raw.created_at, "created_at"),
  };
  if (type === "room.message") {
    if (raw.mention_id != null || raw.message_version != null) {
      throw new ProtocolViolation("普通消息不应带 mention 字段");
    }
    return event;
  }
  event.mentionId = positiveInt(raw.mention_id, "mention_id");
  if (typeof raw.message_version !== "string" || !/^[0-9a-f]{64}$/.test(raw.message_version)) {
    throw new ProtocolViolation("message_version 无效");
  }
  if (containsSecret(raw.message_version, expected.token)) {
    throw new ProtocolViolation("message_version 含有不允许的内容");
  }
  event.messageVersion = raw.message_version;
  return event;
}

function containsSecret(value: string, token: string): boolean {
  return token.length > 0 && value.toLowerCase().includes(token.toLowerCase());
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProtocolViolation(`${field} 必须是正整数`);
  }
  return value;
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolViolation(`${field} 必须是非负整数`);
  }
  return value;
}

function httpFatalText(status: number): string | undefined {
  if (status >= 300 && status < 400) {
    return "WebSocket 握手被重定向（HTTP 3xx）：为避免凭证泄露，已拒绝跟随";
  }
  if (status === 401 || status === 403) {
    return `WebSocket 握手被拒绝（HTTP ${status}）：凭证或权限有问题，请检查 KNOT_AGENT_TOKEN 与 Knot 会话 ID`;
  }
  if (status === 404) {
    return "WebSocket 握手失败（HTTP 404）：请检查 WS 地址与 Knot 会话 ID";
  }
  if (status >= 400 && status < 500) {
    return `WebSocket 握手被拒绝（HTTP ${status}）：请检查 WS 地址与会话 ID`;
  }
  return undefined;
}

function responseStatus(response: unknown): number {
  const status = isRecord(response) ? response.statusCode : undefined;
  return typeof status === "number" ? status : 0;
}

function describeError(error: unknown): string {
  if (error instanceof AttemptError || error instanceof FatalAttemptError || error instanceof ProtocolViolation) {
    return error.message;
  }
  return `连接异常（${safeErrorCode(error) ?? "未知错误"}）`;
}

function safeErrorCode(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) {
    return code;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
