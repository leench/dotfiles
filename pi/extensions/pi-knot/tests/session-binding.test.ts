/**
 * 每个 Pi 逻辑对话一个 Knot 会话：首次接入自动创建、恢复复用、绝不借用全局旧 ID，
 * 并且 Knot 工具调用只能用本对话绑定的那一个 id。
 *
 * 全部走本地 127.0.0.1 假服务与临时 HOME，不接触任何正式凭证或正式 Room。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearOwnPendingCreation, markPendingCreation, pendingCreationPath, shortId } from "../src/store.ts";
import { test } from "node:test";
import knotExtension from "../index.ts";
import { FakeKnot, TEST_TOKEN, delay, waitFor, writeAgentConfig } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Harness {
  handlers: Map<string, Handler[]>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  ctx: any;
  notices: { message: string; type?: string }[];
  status: (string | undefined)[];
  guidelines: string[][];
}

function harness(sessionId: string): Harness {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices: { message: string; type?: string }[] = [];
  const status: (string | undefined)[] = [];
  const guidelines: string[][] = [];
  const pi: any = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    sendMessage() {},
    registerTool() {},
    appendEntry() {},
  };
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus(_key: string, text?: string) {
        status.push(text);
      },
      notify(message: string, type?: string) {
        notices.push({ message, type });
      },
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "Pi 测试对话",
    },
    isIdle: () => true,
  };
  knotExtension(pi);
  return { handlers, commands, ctx, notices, status, guidelines };
}

async function emit(helpers: Harness, name: string, event: unknown): Promise<void> {
  for (const handler of helpers.handlers.get(name) ?? []) {
    await handler(event, helpers.ctx);
  }
}

/** 让假服务为每次创建返回一个新的递增 id。 */
function allocateIds(server: FakeKnot, ids: number[]): { created: number[] } {
  const created: number[] = [];
  server.restHandler = (url: URL) => {
    if (url.pathname !== "/api/agent/sessions") {
      return { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
    }
    const id = ids[created.length] ?? 99;
    created.push(id);
    return { status: 201, body: { id, name: `自动创建 ${id}` } };
  };
  return { created };
}

function useAgentDir(dir: string): void {
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.KNOT_AGENT_TOKEN = TEST_TOKEN;
  delete process.env.KNOT_REST_URL;
  delete process.env.KNOT_WS_URL;
  delete process.env.KNOT_AGENT_SESSION_ID;
}

test("两个 Pi 对话各自自动创建 Knot 会话，互不共享 ID", async () => {
  const server = await FakeKnot.create();
  const { created } = allocateIds(server, [11, 12]);
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  server.onConnection = (connection) => connection.sendReady({ sessionId: Number(connection.url.split("/").pop()) });
  const first = harness("pi-session-a");
  const second = harness("pi-session-b");
  try {
    await emit(first, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => server.connections.length === 1, 3_000, "第一个对话连上");
    await emit(second, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => server.connections.length === 2, 3_000, "第二个对话连上");

    assert.deepEqual(created, [11, 12], "每个对话只创建一次，且拿到不同 ID");
    assert.deepEqual(
      server.upgrades.map((item) => item.url).sort(),
      ["/ws/agent-sessions/11", "/ws/agent-sessions/12"],
    );
    // 反向绑定按 Pi 对话隔离，正向绑定按 Knot 会话隔离。
    const reverseA = JSON.parse(readFileSync(join(dir, "pi-knot", "pi-sessions", "pi-session-a.json"), "utf8"));
    const reverseB = JSON.parse(readFileSync(join(dir, "pi-knot", "pi-sessions", "pi-session-b.json"), "utf8"));
    assert.equal(reverseA.agentSessionId, 11);
    assert.equal(reverseB.agentSessionId, 12);
  } finally {
    await emit(first, "session_shutdown", { type: "session_shutdown" });
    await emit(second, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("恢复同一 Pi 对话复用已有 ID，不再创建新会话", async () => {
  const server = await FakeKnot.create();
  const { created } = allocateIds(server, [21]);
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  server.onConnection = (connection) => connection.sendReady({ sessionId: 21 });
  const first = harness("pi-session-same");
  try {
    await emit(first, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => server.connections.length === 1, 3_000, "首次连接");
    await emit(first, "session_shutdown", { type: "session_shutdown" });

    const again = harness("pi-session-same");
    await emit(again, "session_start", { type: "session_start", reason: "resume" });
    await waitFor(() => server.connections.length === 2, 3_000, "恢复后重连");
    assert.deepEqual(created, [21], "恢复不重复创建");
    assert.equal(server.upgrades.at(-1)?.url, "/ws/agent-sessions/21");
  } finally {
    await server.stop();
  }
});

test("配置里的旧 agentSessionId 不会被自动认领", async () => {
  const server = await FakeKnot.create();
  const { created } = allocateIds(server, [31]);
  // 旧配置写着 5，但本对话应当拿到服务端新建的 31。
  const dir = writeAgentConfig({ restUrl: server.restUrl, agentSessionId: 5, allowLocalhost: true });
  useAgentDir(dir);
  server.onConnection = (connection) => connection.sendReady({ sessionId: 31 });
  const helpers = harness("pi-session-legacy");
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => server.connections.length === 1, 3_000, "连接");
    assert.deepEqual(created, [31]);
    assert.equal(server.upgrades.at(-1)?.url, "/ws/agent-sessions/31");
    assert.equal(
      helpers.notices.some((notice) => /\/knot connect 5/.test(notice.message)),
      false,
      "旧 ID 属于正常回退，不再作为启动提示（可用 /knot status 查看）",
    );
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("创建被明确拒绝（401）时可重试，且不会回退到旧 ID", async () => {
  const server = await FakeKnot.create();
  let attempts = 0;
  server.restHandler = (url: URL) => {
    if (url.pathname !== "/api/agent/sessions") {
      return { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
    }
    attempts += 1;
    return attempts === 1
      ? { status: 401, body: { detail: "凭证无效" } }
      : { status: 201, body: { id: 41, name: "重试成功" } };
  };
  const dir = writeAgentConfig({ restUrl: server.restUrl, agentSessionId: 5, allowLocalhost: true });
  useAgentDir(dir);
  const helpers = harness("pi-session-retry");
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => attempts === 1, 3_000, "首次尝试");
    await delay(120);
    assert.equal(server.connections.length, 0, "创建失败不连接");
    assert.equal(existsSync(join(dir, "pi-knot", "pi-sessions", "pi-session-retry.json")), false);
    // 服务端明确失败可以重试，且仍然不会退回旧 ID 5。
    await helpers.commands.get("knot")!.handler("connect", helpers.ctx);
    await waitFor(() => attempts === 2, 3_000, "重试创建");
    await waitFor(() => server.upgrades.length === 1, 3_000, "重试后连接");
    assert.equal(server.upgrades.at(-1)?.url, "/ws/agent-sessions/41");
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("创建结果不确定时保留 pending 标记，下次启动不再自动创建", async () => {
  const server = await FakeKnot.create();
  const { created } = allocateIds(server, [51]);
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  // 第一次返回 2xx 但内容不可解析：结果不确定。
  let calls = 0;
  server.restHandler = (url: URL) => {
    if (url.pathname !== "/api/agent/sessions") {
      return { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
    }
    calls += 1;
    return { status: 201, body: { id: "not-a-number" } };
  };
  const helpers = harness("pi-session-unknown");
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => calls === 1, 3_000, "首次尝试");
    await delay(120);
    const pending = join(dir, "pi-knot", "pending", "pi-session-unknown.json");
    assert.equal(existsSync(pending), true, "结果不确定必须保留 pending 标记");

    const again = harness("pi-session-unknown");
    await emit(again, "session_start", { type: "session_start", reason: "startup" });
    await delay(150);
    assert.equal(calls, 1, "有 pending 标记时不再自动创建");
    assert.ok(
      again.notices.some((notice) => /结果未知/.test(notice.message)),
      "应说明为什么没有自动创建",
    );
    assert.deepEqual(created, [], "没有伪造成功身份");
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("Knot 工具只能使用本对话绑定的会话 ID", async () => {
  const server = await FakeKnot.create();
  const { created } = allocateIds(server, [61]);
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  server.onConnection = (connection) => connection.sendReady({ sessionId: 61 });
  const helpers = harness("pi-session-tools");
  const check = (event: unknown) => {
    for (const handler of helpers.handlers.get("tool_call") ?? []) {
      const result = handler(event, helpers.ctx);
      if (result) {
        return result as { block?: boolean; reason?: string };
      }
    }
    return undefined;
  };
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => created.length === 1, 3_000, "绑定完成");

    assert.equal(
      check({ type: "tool_call", toolCallId: "1", toolName: "mcp__knot__send_message", input: { agent_session_id: 61 } }),
      undefined,
      "绑定 ID 放行",
    );
    const wrong = check({
      type: "tool_call",
      toolCallId: "2",
      toolName: "mcp__knot__send_message",
      input: { agent_session_id: 5 },
    });
    assert.equal(wrong?.block, true);
    assert.match(wrong?.reason ?? "", /61/);

    // codemode / tool_search 的嵌套调用也带 parentToolCallId，同样要拦。
    const nested = check({
      type: "tool_call",
      toolCallId: "3/1",
      parentToolCallId: "3",
      toolName: "mcp__knot__get_room",
      input: { agent_session_id: 9999 },
    });
    assert.equal(nested?.block, true);

    assert.equal(
      check({ type: "tool_call", toolCallId: "4", toolName: "bash", input: { command: "ls" } }),
      undefined,
      "非 Knot 工具不受影响",
    );
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("未绑定时 Knot 工具被拒绝，而不是借用别人的 ID", async () => {
  const server = await FakeKnot.create();
  // 创建永远失败：本对话保持未绑定。
  server.restHandler = (url: URL) =>
    url.pathname === "/api/agent/sessions"
      ? { status: 500, body: { detail: "denied" } }
      : { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  const helpers = harness("pi-session-unbound");
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await delay(200);
    let blocked: { block?: boolean; reason?: string } | undefined;
    for (const handler of helpers.handlers.get("tool_call") ?? []) {
      blocked = (handler(
        { type: "tool_call", toolCallId: "1", toolName: "mcp__knot__list_rooms", input: { agent_session_id: 5 } },
        helpers.ctx,
      ) ?? undefined) as never;
    }
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /尚未绑定/);
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("系统提示只带本对话的会话 ID，不含凭证", async () => {
  const server = await FakeKnot.create();
  const { created } = allocateIds(server, [71]);
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  server.onConnection = (connection) => connection.sendReady({ sessionId: 71 });
  const helpers = harness("pi-session-prompt");
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => created.length === 1, 3_000, "绑定完成");
    const options = { promptGuidelines: [] as string[] };
    for (const handler of helpers.handlers.get("before_agent_start") ?? []) {
      await handler({ type: "before_agent_start", systemPromptOptions: options }, helpers.ctx);
    }
    const text = options.promptGuidelines.join("\n");
    assert.match(text, /71/);
    assert.equal(text.includes(TEST_TOKEN), false, "提示里不能出现凭证");
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("5xx 与异常 2xx 都当作“可能已创建”，不再自动重试", async () => {
  for (const response of [
    { status: 502, body: { detail: "gateway" } },
    { status: 200, body: { unexpected: true } },
    { status: 204, body: undefined },
  ]) {
    const server = await FakeKnot.create();
    let calls = 0;
    server.restHandler = (url: URL) => {
      if (url.pathname !== "/api/agent/sessions") {
        return { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
      }
      calls += 1;
      return response as never;
    };
    const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
    useAgentDir(dir);
    try {
      const helpers = harness(`pi-session-uncertain-${response.status}`);
      await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
      await waitFor(() => calls === 1, 3_000, `首次尝试 ${response.status}`);
      await delay(120);
      assert.equal(
        existsSync(join(dir, "pi-knot", "pending", `pi-session-uncertain-${response.status}.json`)),
        true,
        `${response.status} 后必须保留 pending 标记`,
      );
      // 用户再点一次 connect 也不能再造一个身份。
      await helpers.commands.get("knot")!.handler("connect", helpers.ctx);
      await delay(150);
      assert.equal(calls, 1, `${response.status} 后不能自动重试`);
      assert.equal(server.upgrades.length, 0, "没有连接");
    } finally {
      await server.stop();
    }
  }
});

test("创建在途时 disconnect：不再连接，但已确认的身份会被保留", async () => {
  const server = await FakeKnot.create();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posted = 0;
  server.restHandler = (url: URL) => {
    if (url.pathname !== "/api/agent/sessions") {
      return { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
    }
    posted += 1;
    return (async () => {
      await gate;
      return { status: 201, body: { id: 701, name: "迟到的身份" } };
    })() as never;
  };
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  const helpers = harness("pi-session-abort");
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => posted === 1, 3_000, "创建已发出");
    await helpers.commands.get("knot")!.handler("disconnect", helpers.ctx);
    release();
    await delay(300);
    assert.equal(server.upgrades.length, 0, "disconnect 后旧结果不能把连接拉起来");
    assert.equal(server.connections.length, 0);
    // 身份已经确定创建：绑定留下来，下次显式 connect 直接复用，不再新建。
    const binding = JSON.parse(readFileSync(join(dir, "pi-knot", "pi-sessions", "pi-session-abort.json"), "utf8"));
    assert.equal(binding.agentSessionId, 701);
    assert.equal(existsSync(join(dir, "pi-knot", "pending", "pi-session-abort.json")), false);
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});

test("同对话的 pending 标记是原子独占：并发的第二个进程不会发 POST", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-knot-pending-"));
  const first = markPendingCreation(dir, "pi-session-race", "first");
  assert.equal(first, true);
  const second = markPendingCreation(dir, "pi-session-race", "second");
  assert.equal(second, false, "同一个对话只能有一个创建者");
  const raw = JSON.parse(readFileSync(pendingCreationPath(dir, "pi-session-race"), "utf8"));
  assert.equal(raw.name, "first", "已有标记不能被覆盖");
  // 别的进程不能替创建者清标记。
  clearOwnPendingCreation(dir, "pi-session-race", process.pid + 1);
  assert.equal(existsSync(pendingCreationPath(dir, "pi-session-race")), true);
  clearOwnPendingCreation(dir, "pi-session-race");
  assert.equal(existsSync(pendingCreationPath(dir, "pi-session-race")), false);
});

test("默认会话名截断时保留唯一后缀", async () => {
  const server = await FakeKnot.create();
  const { created } = allocateIds(server, [81]);
  const dir = writeAgentConfig({ restUrl: server.restUrl, allowLocalhost: true });
  useAgentDir(dir);
  const helpers = harness("pi-session-long-name");
  helpers.ctx.sessionManager.getSessionName = () => "非常长的对话标题".repeat(12);
  try {
    await emit(helpers, "session_start", { type: "session_start", reason: "startup" });
    await waitFor(() => created.length === 1, 3_000, "创建完成");
    const sent = JSON.parse(server.lastBody) as { name: string };
    assert.ok(sent.name.length <= 80, `名字超长：${sent.name.length}`);
    assert.ok(
      sent.name.endsWith(` · ${shortId("pi-session-long-name")}`),
      `必须保留唯一后缀，实际：${sent.name}`,
    );
  } finally {
    await emit(helpers, "session_shutdown", { type: "session_shutdown" });
    await server.stop();
  }
});
