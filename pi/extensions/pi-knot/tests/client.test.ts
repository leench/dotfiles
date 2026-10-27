import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { KnotClient, type Timings, type WsLike } from "../src/client.ts";
import { StateStore } from "../src/store.ts";
import {
  FakeKnot,
  TEST_TOKEN,
  deferred,
  delay,
  loadTestConfig,
  makeEvent,
  waitFor,
  writeAgentConfig,
} from "./helpers.ts";

const FAST: Partial<Timings> = {
  backoffBaseMs: 20,
  backoffMaxMs: 60,
  readyMs: 800,
  silenceMs: 800,
  requestMs: 800,
  pageSize: 2,
  bufferLimit: 64,
};

interface Harness {
  server: FakeKnot;
  store: StateStore;
  client: KnotClient;
  config: ReturnType<typeof loadTestConfig>;
}

async function harness(overrides: Partial<Timings> = {}, extra: Partial<ConstructorParameters<typeof KnotClient>[0]> = {}): Promise<Harness> {
  const server = await FakeKnot.create();
  const agentDir = writeAgentConfig({ restUrl: server.restUrl, agentSessionId: 5, allowLocalhost: true });
  const config = loadTestConfig(agentDir);
  const store = new StateStore(config.stateDir, config.serviceKey, config.agentSessionId);
  store.open();
  const client = new KnotClient({ config, store, timings: { ...FAST, ...overrides }, ...extra });
  return { server, store, client, config };
}

test("单条连接接收多个 Room 的事件，并立即回应用层 pong", async () => {
  const { server, store, client } = await harness();
  try {
    server.onConnection = (connection) => {
      connection.sendReady({
        rooms: [
          { id: 1, title: "Room 1", latest_seq: 3 },
          { id: 2, title: "Room 2", latest_seq: 4 },
        ],
      });
      connection.sendHeartbeat();
      connection.send(makeEvent({ event_id: 1, room_id: 1 }));
      connection.send(makeEvent({ event_id: 2, room_id: 2 }));
    };
    client.start();
    await waitFor(() => store.events.length === 2, 3_000, "两个 Room 的事件");
    assert.deepEqual(
      store.events.map((event) => event.roomId),
      [1, 2],
    );
    await waitFor(() => server.lastConnection.pongAt.length > 0, 1_000, "pong");
    assert.equal(server.connections.length, 1, "所有 Room 共用一条连接");
    assert.equal(store.cursor, 2);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("ready + 分页补拉 + 实时帧交错：不漏、不重、按 ID 排序", async () => {
  const { server, store, client } = await harness();
  const pages = new Map([
    [0, [1, 2]],
    [2, [3, 4]],
    [4, [5]],
  ]);
  try {
    server.restHandler = async (url) => {
      const after = Number(url.searchParams.get("after_id"));
      if (after === 0) {
        await delay(80);
      }
      const ids = pages.get(after) ?? [];
      return {
        status: 200,
        body: {
          events: ids.map((id) => makeEvent({ event_id: id })),
          next_cursor: ids.length ? ids[ids.length - 1] : after,
          has_more: after < 4,
        },
      };
    };
    server.onConnection = (connection) => {
      connection.sendReady({ latestEventId: 5 });
      connection.send(makeEvent({ event_id: 6 }));
      connection.send(makeEvent({ event_id: 7 }));
      connection.send(makeEvent({ event_id: 4 }));
    };
    client.start();
    await waitFor(() => store.cursor === 7, 3_000, "游标推进到 7");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(store.events.length, 7);
    assert.equal(store.unreadCount(), 7);
    const afterIds = server.requests.map((request) => request.query.after_id);
    assert.deepEqual(afterIds, ["0", "2", "4"]);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("重复事件被忽略，ID 间隙正常，ready 水位不被当作已处理游标", async () => {
  const { server, store, client } = await harness();
  try {
    server.restHandler = () => ({
      status: 200,
      body: {
        events: [5, 9, 10].map((id) => makeEvent({ event_id: id })),
        next_cursor: 10,
        has_more: false,
      },
    });
    server.onConnection = (connection) => {
      connection.sendReady({ latestEventId: 999 });
      connection.send(makeEvent({ event_id: 10 }));
      connection.send(makeEvent({ event_id: 11 }));
    };
    client.start();
    await waitFor(() => store.cursor === 11, 3_000, "游标 11");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [5, 9, 10, 11],
    );
    assert.equal(store.events.filter((event) => event.eventId === 10).length, 1);
    assert.notEqual(store.cursor, 999, "ready.latest_event_id 不是已处理游标");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("保存失败不推进游标，重连后补拉不丢事件", async () => {
  const observedCursors: number[] = [];
  const { server, store, client } = await harness();
  const original = store.commitEvents.bind(store);
  let failed = false;
  store.commitEvents = (events) => {
    if (!failed) {
      failed = true;
      observedCursors.push(store.cursor);
      throw new Error("EIO");
    }
    return original(events);
  };
  try {
    server.restHandler = () => ({
      status: 200,
      body: { events: [1, 2].map((id) => makeEvent({ event_id: id })), next_cursor: 2, has_more: false },
    });
    server.onConnection = (connection) => connection.sendReady();
    client.start();
    await waitFor(() => store.cursor === 2 && store.events.length === 2, 3_000, "重试后补齐");
    assert.deepEqual(observedCursors, [0], "落盘失败时游标仍为 0，事件没有被跳过");
    assert.ok(server.connections.length >= 2, "失败后重新连接并补拉");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("实时缓存溢出时断线，并按持久游标补拉恢复", async () => {
  const { server, store, client } = await harness({ bufferLimit: 2, requestMs: 500 });
  let firstFetch = true;
  try {
    server.restHandler = async () => {
      if (firstFetch) {
        firstFetch = false;
        await delay(300);
      }
      return {
        status: 200,
        body: {
          events: [1, 2, 3, 4, 5].map((id) => makeEvent({ event_id: id })),
          next_cursor: 5,
          has_more: false,
        },
      };
    };
    let livePushed = false;
    server.onConnection = (connection) => {
      connection.sendReady();
      if (livePushed) {
        return;
      }
      livePushed = true;
      for (const id of [1, 2, 3, 4, 5]) {
        connection.send(makeEvent({ event_id: id }));
      }
    };
    client.start();
    await waitFor(() => store.cursor === 5, 4_000, "溢出后恢复");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [1, 2, 3, 4, 5],
    );
    assert.ok(server.connections.length >= 2, "溢出后应重新连接");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("慢 REST 补拉期间心跳仍被及时回应", async () => {
  const { server, store, client } = await harness({ requestMs: 3_000 });
  const beatAt: number[] = [];
  try {
    server.restHandler = async () => {
      await delay(400);
      return { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
    };
    server.onConnection = (connection) => {
      connection.sendReady();
      const timer = setInterval(() => {
        beatAt.push(Date.now());
        connection.sendHeartbeat();
      }, 40);
      setTimeout(() => clearInterval(timer), 500);
    };
    client.start();
    await waitFor(() => server.connections.length === 1, 2_000, "建立连接");
    const connection = server.connections[0];
    await waitFor(() => connection.pongAt.length >= 3, 3_000, "至少 3 次 pong");
    const pongs = connection.pongAt;
    const latencies = pongs.map((at, index) => at - (beatAt[index] ?? at));
    assert.ok(Math.max(...latencies) < 150, `pong 延迟过大：${latencies.join(",")}`);
    assert.equal(store.cursor, 0);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("4401/4403/4409 停止自动重连", async () => {
  for (const code of [4401, 4403, 4409]) {
    const { server, client } = await harness();
    try {
      server.onConnection = (connection) => connection.close(code, "TEST_REASON");
      client.start();
      await waitFor(() => client.status === "stopped", 2_500, `${code} 停止`);
      assert.match(client.lastError ?? "", new RegExp(String(code)));
      await delay(150);
      assert.equal(server.connections.length, 1, `${code} 不应自动重连`);
    } finally {
      client.stop();
      await server.stop();
    }
  }
});

test("4408/1011 退避重连并重新补拉", async () => {
  for (const code of [4408, 1011]) {
    const { server, store, client } = await harness();
    let closes = 0;
    try {
      server.restHandler = () => ({
        status: 200,
        body: { events: [makeEvent({ event_id: 1 })], has_more: false },
      });
      server.onConnection = (connection) => {
        closes += 1;
        if (closes <= 2) {
          connection.close(code, "TEST_REASON");
          return;
        }
        connection.sendReady();
      };
      client.start();
      await waitFor(() => server.connections.length >= 3, 3_000, `${code} 重连`);
      await waitFor(() => store.cursor === 1, 3_000, `${code} 补拉`);
      assert.notEqual(client.status, "stopped");
    } finally {
      client.stop();
      await server.stop();
    }
  }
});

test("退避间隔有上限并带抖动", async () => {
  const { server, client } = await harness({ backoffBaseMs: 30, backoffMaxMs: 120 });
  const attempts: number[] = [];
  try {
    server.onConnection = (connection) => {
      attempts.push(Date.now());
      connection.terminate();
    };
    client.start();
    await waitFor(() => attempts.length >= 5, 5_000, "至少 5 次连接尝试");
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
    assert.ok(Math.max(...gaps) <= 250, `间隔应受上限约束：${gaps.join(",")}`);
    assert.ok(Math.max(...gaps) >= 50, `退避应逐步增大：${gaps.join(",")}`);
    assert.ok(gaps.every((gap) => gap >= 10));
  } finally {
    client.stop();
    await server.stop();
  }
});

test("手动 stop 后不再重连，也不接受旧帧", async () => {
  const { server, client } = await harness();
  try {
    server.onConnection = (connection) => connection.sendReady();
    client.start();
    await waitFor(() => server.connections.length === 1, 2_000, "首次连接");
    client.stop();
    client.stop();
    await delay(200);
    assert.equal(server.connections.length, 1);
    assert.equal(client.status, "idle");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("reload 式重建连接后，旧 socket 的回调不影响新连接", async () => {
  const sockets: FakeSocket[] = [];
  const { server, store, client } = await harness(
    {},
    {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ events: [], next_cursor: 0, has_more: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  );
  try {
    client.start();
    assert.equal(sockets.length, 1);
    sockets[0].emit("message", JSON.stringify({ type: "ready", agent_session_id: 5, rooms: [], latest_event_id: 0 }));
    await waitFor(() => client.status === "connected", 2_000, "首次连接完成");

    client.stop();
    assert.equal(sockets[0].terminated, true);
    sockets[0].emit("message", JSON.stringify(makeEvent({ event_id: 1 })));
    sockets[0].emit("close", 1006);
    await delay(120);
    assert.equal(sockets.length, 1, "停止后旧回调不能触发重连");
    assert.equal(store.events.length, 0);

    client.start();
    assert.equal(sockets.length, 2);
    sockets[1].emit("message", JSON.stringify({ type: "ready", agent_session_id: 5, rooms: [], latest_event_id: 0 }));
    await waitFor(() => client.status === "connected", 2_000, "新连接完成");
    sockets[0].emit("message", JSON.stringify(makeEvent({ event_id: 2 })));
    sockets[1].emit("message", JSON.stringify(makeEvent({ event_id: 3 })));
    await waitFor(() => store.events.length === 1, 2_000, "只接收新连接的事件");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [3],
    );
  } finally {
    client.stop();
    await server.stop();
  }
});

test("Token 不出现在状态、持久记录和 REST URL 中", async () => {
  const { server, store, client } = await harness();
  let calls = 0;
  try {
    server.restHandler = () => {
      calls += 1;
      if (calls === 1) {
        return { status: 200, body: { events: [], next_cursor: 0, has_more: false } };
      }
      return { status: 500, body: { detail: `server echoed ${TEST_TOKEN}` } };
    };
    server.onConnection = (connection) => {
      connection.sendReady();
      connection.send(makeEvent({ event_id: 1, summary: `leak ${TEST_TOKEN} in summary` }));
      setTimeout(() => connection.close(4408, `reason ${TEST_TOKEN}`), 80);
    };
    client.start();
    await waitFor(() => store.events.length === 1, 3_000, "事件入箱");
    await waitFor(() => (client.lastError ?? "").includes("500"), 3_000, "重连后 REST 失败");
    assert.doesNotMatch(client.lastError ?? "", new RegExp(TEST_TOKEN));
    assert.doesNotMatch(JSON.stringify(store.events), new RegExp(TEST_TOKEN));
    assert.match(JSON.stringify(store.events), /\*\*\*/);
    assert.doesNotMatch(readFileSync(store.file, "utf8"), new RegExp(TEST_TOKEN));
    for (const request of server.requests) {
      assert.doesNotMatch(request.url, new RegExp(TEST_TOKEN));
    }
    assert.equal(server.lastConnection.authorization, `Bearer ${TEST_TOKEN}`);
  } finally {
    client.stop();
    await server.stop();
  }
});

test("握手被重定向或权限拒绝时停止重试", async () => {
  const cases = [
    { status: 302, pattern: /重定向/ },
    { status: 401, pattern: /凭证|权限/ },
    { status: 403, pattern: /凭证|权限/ },
  ];
  for (const item of cases) {
    const { server, client } = await harness();
    try {
      server.httpStatusOverride = item.status;
      client.start();
      await waitFor(() => client.status === "stopped", 2_500, `HTTP ${item.status} 停止`);
      assert.match(client.lastError ?? "", item.pattern);
      await delay(120);
      assert.equal(server.connections.length, 0, "握手失败不应建立连接");
      assert.equal(server.upgrades.length, 1, "不应自动重试");
    } finally {
      client.stop();
      await server.stop();
    }
  }
});

test("旧 attempt 的迟到补拉响应不写入新连接、不清新缓存、不打断新连接", async () => {
  const pages: ((response: Response) => void)[] = [];
  const { server, store, client } = await harness(
    { backoffBaseMs: 20, backoffMaxMs: 40 },
    {
      // 故意忽略 AbortSignal：fetch 取消不是正确性保证。
      fetchImpl: ((_input: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pages.push(resolve);
        })) as unknown as typeof fetch,
    },
  );
  let connections = 0;
  try {
    server.onConnection = (connection) => {
      connections += 1;
      connection.sendReady();
      if (connections === 1) {
        setTimeout(() => connection.close(4408, "slow"), 30);
        return;
      }
      connection.send(makeEvent({ event_id: 5 }));
    };
    client.start();
    await waitFor(() => pages.length === 1, 2_000, "第一次补拉请求");
    await waitFor(() => connections === 2 && pages.length === 2, 3_000, "第二次补拉请求");
    const second = server.connections[1];
    await waitFor(() => client.status === "catching-up", 1_000, "第二次补拉中");

    pages[0](
      new Response(JSON.stringify({ events: [makeEvent({ event_id: 900 })], has_more: false }), { status: 200 }),
    );
    await delay(80);
    assert.equal(store.events.length, 0, "旧 attempt 的页面不能入箱");
    assert.equal(client.status, "catching-up", "旧 attempt 不能把状态改成已连接");
    assert.equal(second.socket.readyState, 1, "旧 attempt 不能终止新连接");
    assert.equal(second.frames.filter((frame) => frame.type === "pong").length, 0);

    pages[1](
      new Response(
        JSON.stringify({ events: [makeEvent({ event_id: 1 }), makeEvent({ event_id: 2 })], has_more: false }),
        { status: 200 },
      ),
    );
    await waitFor(() => store.cursor === 5, 3_000, "新连接补齐并排空自己的缓存");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [1, 2, 5],
      "旧页的 900 不能混入，新连接缓存也不能被旧 attempt 清掉",
    );
    assert.equal(client.status, "connected");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("补拉超时结束 attempt 后，迟到的响应（即使 fetch 不响应取消）也被丢弃", async () => {
  const pages: ((response: Response) => void)[] = [];
  let calls = 0;
  const { server, store, client } = await harness(
    { requestMs: 40, backoffBaseMs: 20, backoffMaxMs: 40 },
    {
      fetchImpl: ((_input: string, _init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          // 第一次请求既不响应 AbortSignal 也不返回：只能靠计时器结束 attempt。
          return new Promise<Response>((resolve) => {
            pages.push(resolve);
          });
        }
        return Promise.resolve(
          new Response(JSON.stringify({ events: [], has_more: false }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    },
  );
  let connections = 0;
  try {
    server.onConnection = (connection) => {
      connections += 1;
      connection.sendReady();
      if (connections === 2) {
        connection.send(makeEvent({ event_id: 3 }));
      }
    };
    client.start();
    await waitFor(() => pages.length === 1, 2_000, "第一次补拉请求");
    await waitFor(() => connections === 2, 3_000, "超时后重连");
    await waitFor(() => store.cursor === 3, 3_000, "重连后补齐实时事件");
    assert.equal(client.status, "connected");

    pages[0](
      new Response(JSON.stringify({ events: [makeEvent({ event_id: 800 })], has_more: false }), { status: 200 }),
    );
    await delay(80);
    assert.equal(store.events.some((event) => event.eventId === 800), false, "超时 attempt 的迟到响应不能入箱");
    assert.equal(client.status, "connected", "旧 attempt 不能改变新连接状态");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("旧 attempt 的迟到响应体（json）在 attempt 结束后被丢弃", async () => {
  const bodies: ((value: unknown) => void)[] = [];
  const { server, store, client } = await harness(
    { backoffBaseMs: 20, backoffMaxMs: 40 },
    {
      fetchImpl: (async () => ({
        status: 200,
        ok: true,
        json: () =>
          new Promise((resolve) => {
            bodies.push(resolve as (value: unknown) => void);
          }),
      })) as unknown as typeof fetch,
    },
  );
  let connections = 0;
  try {
    server.onConnection = (connection) => {
      connections += 1;
      connection.sendReady();
      if (connections === 1) {
        setTimeout(() => connection.close(4408, "slow"), 30);
        return;
      }
      connection.send(makeEvent({ event_id: 4 }));
    };
    client.start();
    await waitFor(() => bodies.length === 1, 2_000, "第一次响应体");
    await waitFor(() => connections === 2 && bodies.length === 2, 3_000, "第二次响应体");

    bodies[0]({ events: [makeEvent({ event_id: 700 })], has_more: false });
    await delay(80);
    assert.equal(store.events.length, 0, "旧响应体不能入箱");
    assert.equal(client.status, "catching-up");

    bodies[1]({ events: [makeEvent({ event_id: 3 })], has_more: false });
    await waitFor(() => store.cursor === 4, 3_000, "新连接补齐");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [3, 4],
    );
  } finally {
    client.stop();
    await server.stop();
  }
});

test("disconnect 之后迟到的补拉响应不写磁盘", async () => {
  const pages: ((response: Response) => void)[] = [];
  const { server, store, client } = await harness(
    {},
    {
      fetchImpl: ((_input: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pages.push(resolve);
        })) as unknown as typeof fetch,
    },
  );
  try {
    server.onConnection = (connection) => connection.sendReady();
    client.start();
    await waitFor(() => pages.length === 1, 2_000, "补拉请求");
    client.stop();
    pages[0](
      new Response(JSON.stringify({ events: [makeEvent({ event_id: 7 })], has_more: false }), { status: 200 }),
    );
    await delay(100);
    assert.equal(store.events.length, 0);
    assert.equal(store.cursor, 0);
    assert.equal(client.status, "idle");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("has_more=true 但补拉没有进展时失败关闭，不进入实时态也不跳过中间事件", async () => {
  const { server, store, client } = await harness({ backoffBaseMs: 20, backoffMaxMs: 40 });
  const retryPage = deferred<{ status: number; body: unknown }>();
  let calls = 0;
  let first = true;
  try {
    server.restHandler = (url) => {
      calls += 1;
      const after = Number(url.searchParams.get("after_id"));
      if (calls === 1) {
        return {
          status: 200,
          body: { events: [1, 2].map((id) => makeEvent({ event_id: id })), has_more: true },
        };
      }
      if (calls === 2) {
        // after=2，返回空页却说还有更多：没有任何进展。
        assert.equal(after, 2);
        return { status: 200, body: { events: [], has_more: true } };
      }
      return retryPage.promise;
    };
    server.onConnection = (connection) => {
      connection.sendReady();
      if (first) {
        first = false;
        // 实时帧带更高的 ID，绝不能在补拉没完成时被排空。
        connection.send(makeEvent({ event_id: 50 }));
      }
    };
    client.start();
    await waitFor(() => store.cursor === 2, 3_000, "前两页落盘");
    await waitFor(() => calls >= 3, 3_000, "无进展后重试补拉");
    await delay(80);
    assert.equal(
      store.events.some((event) => event.eventId === 50),
      false,
      "无进展时必须回退到持久游标，不能先排空缓存",
    );
    assert.notEqual(client.status, "connected");

    retryPage.resolve({
      status: 200,
      body: { events: [3, 50].map((id) => makeEvent({ event_id: id })), has_more: false },
    });
    await waitFor(() => store.cursor === 50, 3_000, "重试后补齐");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [1, 2, 3, 50],
    );
    assert.equal(client.status, "connected");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("补拉页全是已处理事件却 has_more=true 时同样失败关闭", async () => {
  const { server, store, client } = await harness({ backoffBaseMs: 20, backoffMaxMs: 40 });
  let calls = 0;
  try {
    server.restHandler = () => {
      calls += 1;
      if (calls === 1) {
        return { status: 200, body: { events: [makeEvent({ event_id: 5 })], has_more: true } };
      }
      if (calls === 2) {
        return { status: 200, body: { events: [makeEvent({ event_id: 5 })], has_more: true } };
      }
      return { status: 200, body: { events: [makeEvent({ event_id: 6 })], has_more: false } };
    };
    server.onConnection = (connection) => connection.sendReady();
    client.start();
    await waitFor(() => store.cursor === 6, 4_000, "重试后继续");
    assert.deepEqual(
      store.events.map((event) => event.eventId),
      [5, 6],
    );
  } finally {
    client.stop();
    await server.stop();
  }
});

test("同一页里重复的 event_id 只入箱一次，重启后快照仍完好", async () => {
  const { server, store, client, config } = await harness();
  try {
    server.restHandler = () => ({
      status: 200,
      body: {
        events: [makeEvent({ event_id: 5 }), makeEvent({ event_id: 5 }), makeEvent({ event_id: 5 })],
        has_more: false,
      },
    });
    server.onConnection = (connection) => connection.sendReady();
    client.start();
    await waitFor(() => store.cursor === 5, 3_000, "事件入箱");
    assert.equal(store.events.length, 1, "页内重复必须去重");

    const reopened = new StateStore(store.dir, config.serviceKey, config.agentSessionId);
    reopened.open();
    assert.equal(reopened.cursor, 5);
    assert.deepEqual(
      reopened.events.map((event) => event.eventId),
      [5],
    );
  } finally {
    client.stop();
    await server.stop();
  }
});

test("error 的 500ms 兜底定时器挂在 attempt 上，stop 时被清除且不重连", async () => {
  const sockets: FakeSocket[] = [];
  const { server, store, client } = await harness(
    {},
    {
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetchImpl: async () => new Response(JSON.stringify({ events: [], has_more: false }), { status: 200 }),
    },
  );
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const tracked = new Set<unknown>();
  try {
    (globalThis as any).setTimeout = (handler: any, ms?: number, ...args: any[]) => {
      const handle = realSetTimeout(handler, ms, ...args);
      if (ms === 500) {
        tracked.add(handle);
      }
      return handle;
    };
    (globalThis as any).clearTimeout = (handle: any) => {
      tracked.delete(handle);
      realClearTimeout(handle);
    };

    client.start();
    assert.equal(sockets.length, 1);
    sockets[0].emit("open");
    sockets[0].emit("error", { code: "ECONNRESET" });
    sockets[0].emit("error", { code: "ECONNRESET" });
    assert.equal(tracked.size, 1, "同一 attempt 只应有一个兜底定时器");

    client.stop();
    assert.equal(tracked.size, 0, "stop 必须清除兜底定时器");
    await delay(600);
    assert.equal(sockets.length, 1, "旧的兜底回调不能触发重连");
    assert.equal(store.events.length, 0);
    assert.equal(client.status, "idle");
  } finally {
    (globalThis as any).setTimeout = realSetTimeout;
    (globalThis as any).clearTimeout = realClearTimeout;
    client.stop();
    await server.stop();
  }
});

class FakeSocket implements WsLike {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  sent: string[] = [];
  terminated = false;

  on(event: string, handler: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (...args: unknown[]) => void);
    this.handlers.set(event, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

test("ready 的 latest_event_id 只作为水位回调，不写进游标", async () => {
  const seen: (number | undefined)[] = [];
  const { server, store, client } = await harness({}, { onReady: (info) => seen.push(info.latestEventId) });
  try {
    server.onConnection = (connection) => connection.sendReady({ latestEventId: 42 });
    client.start();
    await waitFor(() => seen.length === 1, 3_000, "ready 回调");
    assert.deepEqual(seen, [42]);
    assert.equal(store.cursor, 0, "ready 水位不能推进本地游标");
  } finally {
    client.stop();
    await server.stop();
  }
});

test("ready 缺少或非法的 latest_event_id 时回调 undefined", async () => {
  const seen: (number | undefined)[] = [];
  const { server, client } = await harness({}, { onReady: (info) => seen.push(info.latestEventId) });
  try {
    server.onConnection = (connection) =>
      connection.send({ type: "ready", agent_session_id: 5, rooms: [], latest_event_id: -3 });
    client.start();
    await waitFor(() => seen.length === 1, 3_000, "ready 回调");
    assert.deepEqual(seen, [undefined]);
  } finally {
    client.stop();
    await server.stop();
  }
});
