/**
 * 本地收件箱与游标。
 *
 * - 游标与收件箱写在同一个 JSON 快照里：先写临时文件 + fsync + 同目录 rename，
 *   落盘成功后内存游标才前进。写入失败不会跳过事件。
 * - 收件箱按（规范化服务地址摘要 + Knot 会话 ID）隔离，文件里不出现 Token。
 * - 跨进程用目录锁互斥（含收件箱读取与“标记已读”），锁只在 owner nonce 匹配时释放。
 * - 快照损坏或与配置不一致时 fail closed：不删除、不覆盖、不自动重置游标。
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const KNOT_EVENT_TYPES = ["room.message", "mention.pending", "mention.execute"] as const;
export type KnotEventType = (typeof KNOT_EVENT_TYPES)[number];

/**
 * 自动投递状态（与 readAt 严格分开）：
 * - sending：已落盘“准备发送”，但尚未确认 sendMessage 返回（异常退出后保留此状态，不自动重发）；
 * - delivered：已经交给当前 Pi 运行时；
 * - failed：sendMessage 抛错，等待用户人工处理。
 */
export type DispatchState = "sending" | "delivered" | "failed";

export interface DispatchRecord {
  state: DispatchState;
  at: number;
}

/** 自动处理起点：armed 表示已从一次可信 ready 建立基线。 */
export interface AutoState {
  armed: boolean;
  /** 自动处理起点（event_id 水位），绝不等于 processed cursor。 */
  baseline: number;
  armedAt?: number;
}

/** 落盘的事件只保留定位与展示需要的白名单字段；外部字段一律丢弃。 */
export interface StoredEvent {
  eventId: number;
  type: KnotEventType;
  roomId: number;
  messageId: number;
  seq: number;
  senderKind: string;
  senderId: number;
  senderName: string;
  summary: string;
  createdAt: number;
  mentionId?: number;
  messageVersion?: string;
  readAt?: number;
  dispatch?: DispatchRecord;
}

interface Snapshot {
  version: 1;
  serviceKey: string;
  agentSessionId: number;
  cursor: number;
  events: StoredEvent[];
  /** 旧快照没有这个字段：保持兼容，缺失即视为“尚未建立自动处理起点”。 */
  auto?: AutoState;
}

export class SnapshotError extends Error {}

export class StateStore {
  readonly dir: string;
  readonly file: string;
  private readonly serviceKey: string;
  private readonly agentSessionId: number;
  private snapshot: Snapshot;
  private loaded = false;

  constructor(dir: string, serviceKey: string, agentSessionId: number) {
    this.dir = dir;
    this.serviceKey = serviceKey;
    this.agentSessionId = agentSessionId;
    this.file = join(dir, "state.json");
    this.snapshot = emptySnapshot(serviceKey, agentSessionId);
  }

  open(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.reload();
  }

  /** 重新从磁盘读取；只在持有本地锁时使用，避免覆盖别的进程写入的未读事件。 */
  reload(): void {
    this.snapshot = readSnapshot(this.file, this.serviceKey, this.agentSessionId);
    this.loaded = true;
  }

  get cursor(): number {
    this.ensureLoaded();
    return this.snapshot.cursor;
  }

  get events(): readonly StoredEvent[] {
    this.ensureLoaded();
    return this.snapshot.events;
  }

  unreadCount(): number {
    this.ensureLoaded();
    return this.snapshot.events.reduce((count, event) => (event.readAt ? count : count + 1), 0);
  }

  find(eventId: number): StoredEvent | undefined {
    this.ensureLoaded();
    return this.snapshot.events.find((event) => event.eventId === eventId);
  }

  /** 原子追加一批事件并推进游标；返回真正新增的条数。失败时内存状态不变。 */
  commitEvents(events: readonly StoredEvent[]): number {
    this.ensureLoaded();
    const known = new Set(this.snapshot.events.map((event) => event.eventId));
    const fresh: StoredEvent[] = [];
    // 同一批里可能重复（例如一页里同一个 event_id 出现两次）：按 event_id 去重后再写，
    // 否则会写出重复 ID 的快照，下次加载会自判损坏。
    for (const event of events) {
      if (event.eventId <= this.snapshot.cursor || known.has(event.eventId)) {
        continue;
      }
      known.add(event.eventId);
      fresh.push(event);
    }
    fresh.sort((left, right) => left.eventId - right.eventId);
    if (fresh.length === 0) {
      return 0;
    }
    const merged = [...this.snapshot.events, ...fresh].sort((left, right) => left.eventId - right.eventId);
    const next: Snapshot = {
      ...this.snapshot,
      cursor: Math.max(this.snapshot.cursor, merged[merged.length - 1].eventId),
      events: merged,
    };
    writeSnapshot(this.file, next);
    this.snapshot = next;
    return fresh.length;
  }

  /** 只更新已读标记，不推进游标；返回是否有变化。 */
  markRead(eventId: number): boolean {
    this.ensureLoaded();
    const current = this.snapshot.events.find((event) => event.eventId === eventId);
    if (!current || current.readAt) {
      return false;
    }
    return this.updateEvent(eventId, { readAt: Date.now() });
  }

  get auto(): AutoState | undefined {
    this.ensureLoaded();
    return this.snapshot.auto;
  }

  /** 建立/更新自动处理起点；同一次落盘写入，绝不触碰 processed cursor。 */
  setAuto(state: AutoState): void {
    this.ensureLoaded();
    const next: Snapshot = { ...this.snapshot, auto: state };
    writeSnapshot(this.file, next);
    this.snapshot = next;
  }

  /** 自动投递的候选：结构化 mention.execute、晚于起点、且从未投递过。 */
  pendingAutoEvents(baseline: number): StoredEvent[] {
    this.ensureLoaded();
    return this.snapshot.events.filter(
      (event) => event.type === "mention.execute" && event.eventId > baseline && !event.dispatch,
    );
  }

  dispatchedCount(): number {
    this.ensureLoaded();
    return this.snapshot.events.reduce(
      (count, event) => (event.dispatch?.state === "delivered" ? count + 1 : count),
      0,
    );
  }

  /** 发送前先落盘 sending：异常退出后不会被当成“未投递”再发一次。 */
  beginDispatch(eventId: number): boolean {
    this.ensureLoaded();
    return this.updateEvent(eventId, { dispatch: { state: "sending", at: Date.now() } });
  }

  finishDispatch(eventId: number, delivered: boolean): boolean {
    this.ensureLoaded();
    return this.updateEvent(eventId, {
      dispatch: { state: delivered ? "delivered" : "failed", at: Date.now() },
    });
  }

  private updateEvent(eventId: number, patch: Partial<StoredEvent>): boolean {
    const index = this.snapshot.events.findIndex((event) => event.eventId === eventId);
    if (index < 0) {
      return false;
    }
    const events = this.snapshot.events.slice();
    events[index] = { ...events[index], ...patch };
    const next: Snapshot = { ...this.snapshot, events };
    writeSnapshot(this.file, next);
    this.snapshot = next;
    return true;
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("Knot 收件箱尚未加载");
    }
  }
}

export interface LockHolder {
  nonce: string;
  pid: number;
  piSessionId: string;
  startedAt: string;
}

export class StateLock {
  readonly dir: string;
  private readonly nonce: string;

  constructor(dir: string, nonce: string) {
    this.dir = dir;
    this.nonce = nonce;
  }

  holder(): LockHolder | undefined {
    return readLockHolder(this.dir);
  }

  release(): void {
    const holder = readLockHolder(this.dir);
    if (!holder || holder.nonce !== this.nonce) {
      return;
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export type AcquireLockResult = { ok: true; lock: StateLock } | { ok: false; holder?: LockHolder };

export function lockPath(stateDir: string): string {
  return join(stateDir, "lock");
}

/**
 * 目录创建是原子的：只有先到者成功。不做“陈旧锁自动接管”，
 * 崩溃留下的锁由用户确认后手工删除，避免与仍在运行的进程抢同一个 Knot 会话。
 */
export function acquireStateLock(stateDir: string, piSessionId: string): AcquireLockResult {
  const dir = lockPath(stateDir);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false, holder: readLockHolder(dir) };
    }
    throw error;
  }
  const nonce = randomUUID();
  const holder: LockHolder = {
    nonce,
    pid: process.pid,
    piSessionId,
    startedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(dir, "owner.json"), `${JSON.stringify(holder)}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { ok: true, lock: new StateLock(dir, nonce) };
}

export interface BindingContext {
  dataDir: string;
  stateDir: string;
  serviceKey: string;
  agentSessionId: number;
  piSessionId: string;
}

export function bindingPath(stateDir: string): string {
  return join(stateDir, "binding.json");
}

export function reverseBindingPath(dataDir: string, piSessionId: string): string {
  return join(dataDir, "pi-sessions", `${piSessionId}.json`);
}

/**
 * 一个 Knot 会话只属于一个 Pi 会话（正向绑定），一个 Pi 会话也只对应一个 Knot 会话（反向绑定）。
 * 因此 /new、/fork 或直接改配置都不会静默复用/切换 Knot 身份。绑定冲突需要人工删除文件。
 */
export function checkBinding(context: BindingContext): void {
  const reverse = readReverseBinding(context);
  if (reverse && (reverse.serviceKey !== context.serviceKey || reverse.agentSessionId !== context.agentSessionId)) {
    throw new Error(
      `本 Pi 会话已绑定另一个 Knot 身份（服务 ${shortId(reverse.serviceKey)} / 会话 ${reverse.agentSessionId}），` +
        `不能静默切换到（服务 ${shortId(context.serviceKey)} / 会话 ${context.agentSessionId}）；` +
        `如确需迁移，请删除 ${reverseBindingPath(context.dataDir, context.piSessionId)} 与目标目录的 binding.json 后重试`,
    );
  }
  const forward = readForwardBinding(context);
  if (!forward) {
    return;
  }
  assertOwner(forward, context);
}

/**
 * 命令路径（inbox/read）只校验绑定，绝不替另一个 Pi 会话建立新绑定。
 */
export function requireBinding(context: BindingContext): void {
  const forward = readForwardBinding(context);
  const reverse = readReverseBinding(context);
  if (forward) {
    // 先给出“已绑定别的 Pi 会话”这种更准确的提示。
    assertOwner(forward, context);
  }
  if (!forward || !reverse) {
    throw new Error(`Knot 会话 ${context.agentSessionId} 尚未绑定到本 Pi 会话；先执行 /knot connect`);
  }
  if (reverse.serviceKey !== context.serviceKey || reverse.agentSessionId !== context.agentSessionId) {
    throw new Error(`本 Pi 会话的绑定与当前配置不一致；先执行 /knot connect 或清理本机绑定文件`);
  }
}

interface ForwardBinding {
  piSessionId: string;
}

function readForwardBinding(context: BindingContext): ForwardBinding | undefined {
  const file = bindingPath(context.stateDir);
  if (!existsSync(file)) {
    return undefined;
  }
  const binding = readJsonObject(file);
  if (binding.version !== 1 || !isInteger(binding.agentSessionId) || typeof binding.piSessionId !== "string") {
    throw new Error(`无法读取 ${file}；为避免误用 Knot 会话，已停止。确认后可手工删除该文件。`);
  }
  if (binding.agentSessionId !== context.agentSessionId || binding.serviceKey !== context.serviceKey) {
    throw new Error(`${file} 与当前配置（服务地址或 Knot 会话 ID）不一致；确认后可手工删除该文件后重试`);
  }
  return { piSessionId: binding.piSessionId };
}

function readReverseBinding(context: BindingContext): { serviceKey: string; agentSessionId: number } | undefined {
  const file = reverseBindingPath(context.dataDir, context.piSessionId);
  if (!existsSync(file)) {
    return undefined;
  }
  const reverse = readJsonObject(file);
  if (
    reverse.version !== 1 ||
    !isInteger(reverse.agentSessionId) ||
    reverse.agentSessionId <= 0 ||
    typeof reverse.serviceKey !== "string" ||
    !reverse.serviceKey
  ) {
    throw new Error(`无法读取 ${file}；为避免误用 Knot 会话，已停止。确认后可手工删除该文件。`);
  }
  return { serviceKey: reverse.serviceKey, agentSessionId: reverse.agentSessionId };
}

function assertOwner(forward: ForwardBinding, context: BindingContext): void {
  if (forward.piSessionId !== context.piSessionId) {
    throw new Error(
      `Knot 会话 ${context.agentSessionId} 已绑定 Pi 会话 ${shortId(forward.piSessionId)}；` +
        `请恢复该 Pi 会话继续使用，或确认后手工删除 ${bindingPath(context.stateDir)} 再重试`,
    );
  }
}

export function rememberBinding(context: BindingContext): void {
  const now = new Date().toISOString();
  const reverseFile = reverseBindingPath(context.dataDir, context.piSessionId);
  mkdirSync(dirname(reverseFile), { recursive: true, mode: 0o700 });
  writeJsonAtomic(reverseFile, {
    version: 1,
    serviceKey: context.serviceKey,
    agentSessionId: context.agentSessionId,
    createdAt: now,
  });
  writeJsonAtomic(bindingPath(context.stateDir), {
    version: 1,
    serviceKey: context.serviceKey,
    agentSessionId: context.agentSessionId,
    piSessionId: context.piSessionId,
    createdAt: now,
  });
}

function readLockHolder(dir: string): LockHolder | undefined {
  const file = join(dir, "owner.json");
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof raw.nonce !== "string" || !isInteger(raw.pid) || typeof raw.piSessionId !== "string") {
      return undefined;
    }
    return {
      nonce: raw.nonce,
      pid: raw.pid,
      piSessionId: raw.piSessionId,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    };
  } catch {
    return undefined;
  }
}

function emptySnapshot(serviceKey: string, agentSessionId: number): Snapshot {
  return { version: 1, serviceKey, agentSessionId, cursor: 0, events: [] };
}

function readSnapshot(file: string, serviceKey: string, agentSessionId: number): Snapshot {
  if (!existsSync(file)) {
    return emptySnapshot(serviceKey, agentSessionId);
  }
  const corrupt = (reason: string): SnapshotError =>
    new SnapshotError(`本地收件箱不可用（${reason}）：${file}；已停止，不会覆盖未读事件`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw corrupt("无法解析 JSON");
  }
  if (!isRecord(raw) || raw.version !== 1) {
    throw corrupt("格式版本不支持");
  }
  if (raw.serviceKey !== serviceKey || raw.agentSessionId !== agentSessionId) {
    throw corrupt("与当前服务地址或 Knot 会话不一致");
  }
  if (!isInteger(raw.cursor) || raw.cursor < 0 || !Array.isArray(raw.events)) {
    throw corrupt("游标或事件列表无效");
  }
  const events: StoredEvent[] = [];
  let previous = 0;
  for (const item of raw.events) {
    const event = parseStoredEvent(item);
    if (!event) {
      throw corrupt("事件字段无效");
    }
    if (event.eventId <= previous) {
      throw corrupt("事件未按 event_id 递增");
    }
    if (event.eventId > raw.cursor) {
      throw corrupt("游标落后于已保存事件");
    }
    previous = event.eventId;
    events.push(event);
  }
  let auto: AutoState | undefined;
  if (raw.auto !== undefined) {
    if (
      !isRecord(raw.auto) ||
      typeof raw.auto.armed !== "boolean" ||
      !isInteger(raw.auto.baseline) ||
      raw.auto.baseline < 0
    ) {
      throw corrupt("自动处理状态无效");
    }
    auto = { armed: raw.auto.armed, baseline: raw.auto.baseline };
    if (isInteger(raw.auto.armedAt) && raw.auto.armedAt > 0) {
      auto.armedAt = raw.auto.armedAt;
    }
  }
  const snapshot: Snapshot = { version: 1, serviceKey, agentSessionId, cursor: raw.cursor, events };
  if (auto) {
    snapshot.auto = auto;
  }
  return snapshot;
}

function parseStoredEvent(value: unknown): StoredEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = KNOT_EVENT_TYPES.find((candidate) => candidate === value.type);
  if (
    !type ||
    !isInteger(value.eventId) ||
    value.eventId <= 0 ||
    !isInteger(value.roomId) ||
    value.roomId <= 0 ||
    !isInteger(value.messageId) ||
    value.messageId <= 0 ||
    !isInteger(value.seq) ||
    value.seq < 0 ||
    !isInteger(value.senderId) ||
    value.senderId < 0 ||
    typeof value.senderKind !== "string" ||
    typeof value.senderName !== "string" ||
    typeof value.summary !== "string" ||
    !isInteger(value.createdAt) ||
    value.createdAt < 0
  ) {
    return undefined;
  }
  const event: StoredEvent = {
    eventId: value.eventId,
    type,
    roomId: value.roomId,
    messageId: value.messageId,
    seq: value.seq,
    senderKind: value.senderKind,
    senderId: value.senderId,
    senderName: value.senderName,
    summary: value.summary,
    createdAt: value.createdAt,
  };
  if (value.mentionId !== undefined) {
    if (!isInteger(value.mentionId) || value.mentionId <= 0) {
      return undefined;
    }
    event.mentionId = value.mentionId;
  }
  if (value.messageVersion !== undefined) {
    if (typeof value.messageVersion !== "string" || !/^[0-9a-f]{64}$/.test(value.messageVersion)) {
      return undefined;
    }
    event.messageVersion = value.messageVersion;
  }
  if (value.readAt !== undefined) {
    if (!isInteger(value.readAt) || value.readAt <= 0) {
      return undefined;
    }
    event.readAt = value.readAt;
  }
  if (value.dispatch !== undefined) {
    if (!isRecord(value.dispatch)) {
      return undefined;
    }
    const state = value.dispatch.state;
    if (state !== "sending" && state !== "delivered" && state !== "failed") {
      return undefined;
    }
    if (!isInteger(value.dispatch.at) || value.dispatch.at <= 0) {
      return undefined;
    }
    event.dispatch = { state, at: value.dispatch.at };
  }
  return event;
}

function writeSnapshot(file: string, snapshot: Snapshot): void {
  writeAtomicText(file, `${JSON.stringify(snapshot)}\n`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  writeAtomicText(file, `${JSON.stringify(value)}\n`);
}

function writeAtomicText(file: string, text: string): void {
  const dir = dirname(file);
  const temporary = join(dir, `.${process.pid}-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 清理失败不影响原始错误。
    }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 同上。
    }
    throw error;
  }
  syncDirectory(dir);
}

/**
 * 目录 fsync 让 rename 落盘。部分文件系统（如 macOS 的某些挂载）不支持打开目录，
 * 这里忽略失败：文件本身已经 fsync，最坏情况是崩溃后丢掉最后一次 rename。
 */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // 忽略：见上。
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略。
      }
    }
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  return isRecord(raw) ? raw : {};
}

export function shortId(value: string): string {
  return value.slice(0, 8);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
