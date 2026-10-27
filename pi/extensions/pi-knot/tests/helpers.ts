/**
 * 测试辅助：本地 127.0.0.1 假 Knot 服务（HTTP + WebSocket），临时目录配置。
 * 不连接任何正式服务，不发消息，不读取正文。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { bindSession, loadConfig, type KnotConfig } from "../src/config.ts";

export const TEST_TOKEN = "test-token-0123456789abcdef";
export const TEST_SESSION_ID = 5;

/** 假服务端返回的事件帧；只用于本地协议测试。 */
export function makeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = Number(overrides.event_id ?? 1);
  return {
    type: "room.message",
    event_id: id,
    agent_session_id: TEST_SESSION_ID,
    room_id: 1,
    message_id: 100 + id,
    seq: 10 + id,
    sender: { kind: "human", id: 2, name: "示例用户" },
    summary: `summary-${id}`,
    created_at: 1_793_010_000 + id,
    ...overrides,
  };
}

export function makeMention(
  type: "mention.pending" | "mention.execute",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = Number(overrides.event_id ?? 1);
  return makeEvent({
    type,
    event_id: id,
    mention_id: 40 + id,
    message_version: "a".repeat(64),
    ...overrides,
  });
}

export function writeAgentConfig(values: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-knot-agent-"));
  writeFileSync(join(dir, "knot.json"), `${JSON.stringify(values, null, 2)}\n`);
  return dir;
}

export function loadTestConfig(agentDir: string, token = TEST_TOKEN): KnotConfig {
  const result = loadConfig({ PI_CODING_AGENT_DIR: agentDir, KNOT_AGENT_TOKEN: token });
  if (!result.ok) {
    throw new Error(`测试配置无效：${result.reason}`);
  }
  return bindSession(result.config, TEST_SESSION_ID);
}

export interface FakeConnection {
  socket: unknown;
  url: string;
  authorization: string | undefined;
  frames: Record<string, unknown>[];
  pongAt: number[];
  send(frame: unknown): void;
  sendReady(options?: { sessionId?: number; latestEventId?: number; rooms?: unknown[] }): void;
  sendHeartbeat(): void;
  close(code: number, reason?: string): void;
  terminate(): void;
}

export type RestResult = { status: number; body?: unknown; headers?: Record<string, string> };

export class FakeKnot {
  readonly requests: { path: string; url: string; authorization?: string; query: Record<string, string> }[] = [];
  readonly upgrades: { url: string }[] = [];
  readonly connections: FakeConnection[] = [];
  /** 非 101 的握手响应，用来验证重定向/权限拒绝的处理。 */
  httpStatusOverride?: number;
  restHandler: (url: URL) => RestResult | Promise<RestResult> = (url) =>
    url.pathname === "/api/agent/sessions"
      ? { status: 201, body: { id: TEST_SESSION_ID, name: `测试会话 · ${TEST_SESSION_ID}` } }
      : { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
  onConnection?: (connection: FakeConnection) => void;
  /** 最近一次 REST 请求的原始 body（测试断言 payload 用）。 */
  lastBody = "";
  port = 0;

  private http?: ReturnType<typeof createServer>;
  private readonly wss = new WebSocketServer({ noServer: true });

  static async create(): Promise<FakeKnot> {
    const server = new FakeKnot();
    await server.start();
    return server;
  }

  get restUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get lastConnection(): FakeConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) {
      throw new Error("还没有 WebSocket 连接");
    }
    return connection;
  }

  async start(): Promise<void> {
    const http = createServer((request, response) => {
      // 收集请求体，测试需要断言实际发送的 payload（例如自动创建的会话名）。
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        this.lastBody = Buffer.concat(chunks).toString("utf8");
        void this.handleRest(request, response);
      });
    });
    http.on("upgrade", (request, socket, head) => {
      this.upgrades.push({ url: request.url ?? "" });
      if (this.httpStatusOverride) {
        socket.write(
          `HTTP/1.1 ${this.httpStatusOverride} Test\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      if (!request.url?.startsWith("/ws/agent-sessions/")) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });
    this.wss.on("connection", (ws: any, request: any) => {
      const connection = createConnection(ws, request.url, request.headers.authorization, this);
      this.connections.push(connection);
      ws.on("message", (data: any) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(data));
        } catch {
          frame = { raw: String(data) };
        }
        connection.frames.push(frame);
        if (frame.type === "pong") {
          connection.pongAt.push(Date.now());
        }
      });
      this.onConnection?.(connection);
    });
    this.http = http;
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    this.port = (http.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) {
      try {
        connection.terminate();
      } catch {
        // 已关闭。
      }
    }
    this.wss.close();
    const http = this.http;
    if (http) {
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  private async handleRest(request: any, response: any): Promise<void> {
    const url = new URL(request.url ?? "/", this.restUrl);
    this.requests.push({
      path: url.pathname,
      url: url.toString(),
      authorization: request.headers.authorization,
      query: Object.fromEntries(url.searchParams),
    });
    let result: RestResult;
    try {
      result = await this.restHandler(url);
    } catch {
      result = { status: 500, body: { detail: "test handler failure" } };
    }
    if (response.destroyed || response.writableEnded) {
      return;
    }
    response.writeHead(result.status, { "content-type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body ?? {}));
  }
}

function createConnection(ws: any, url: string, authorization: string | undefined, server: FakeKnot): FakeConnection {
  return {
    socket: ws,
    url,
    authorization,
    frames: [],
    pongAt: [],
    send(frame: unknown) {
      if (ws.readyState !== 1) {
        return;
      }
      ws.send(JSON.stringify(frame));
    },
    sendReady(options: { sessionId?: number; latestEventId?: number; rooms?: unknown[] } = {}) {
      this.send({
        type: "ready",
        agent_session_id: options.sessionId ?? TEST_SESSION_ID,
        rooms: options.rooms ?? [{ id: 1, title: "示例 Room", latest_seq: 10 }],
        latest_event_id: options.latestEventId ?? 0,
      });
    },
    sendHeartbeat() {
      this.send({ type: "heartbeat", ts: Math.floor(Date.now() / 1000) });
    },
    close(code: number, reason = "") {
      if (ws.readyState !== 1) {
        return;
      }
      ws.close(code, reason);
    },
    terminate() {
      try {
        ws.terminate();
      } catch {
        // 已关闭。
      }
    },
    server,
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
  label = "条件",
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`等待超时：${label}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
