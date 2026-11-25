/**
 * 项目级自动加入的纯函数与 MCP 传输测试。
 *
 * 全部使用临时目录与假响应：不读取任何真实令牌、不发起真实 join、不连接正式服务。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatAutoJoinResults,
  joinProjectRoom,
  loadProjectAutoJoin,
  normalizeLink,
  parseSeatRefusal,
  projectAutoJoinFile,
} from "../src/autojoin.ts";
import { callKnotTool, parseMcpPayload } from "../src/mcp.ts";

const BASE = "https://knot.example.com";
const TOKEN = "fake-token-not-real";
/** 服务端 seat_id 形如 secrets.token_hex(16)。 */
const SEAT = "0123456789abcdef0123456789abcdef";

function projectDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-knot-project-"));
  if (config !== undefined) {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "knot.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

function entriesOf(config: unknown) {
  const result = loadProjectAutoJoin(projectDir(config), BASE);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok("entries" in result);
  return result;
}

test("没有项目配置或没有 autoJoin 时保持现状且不提示", () => {
  const absent = loadProjectAutoJoin(projectDir(), BASE);
  assert.equal(absent.ok, false);
  assert.equal((absent as { missing: boolean }).missing, true);

  const empty = loadProjectAutoJoin(projectDir({}), BASE);
  assert.equal(empty.ok, false);
  assert.equal((empty as { missing: boolean }).missing, true);
});

test("字符串项与对象项都能读出 replaceOffline，默认不接替", () => {
  const { entries, warnings } = entriesOf({
    autoJoin: [
      `${BASE}/j/aaaaaaaa`,
      { link: `${BASE}/j/bbbbbbbb`, replaceOffline: true },
    ],
  });
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    entries.map((entry: { replaceOffline: boolean }) => entry.replaceOffline),
    [false, true],
  );
});

test("非法 JSON、非对象、autoJoin 非数组都给出明确原因", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-knot-project-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "knot.json"), "{ not json");
  const broken = loadProjectAutoJoin(dir, BASE);
  assert.equal(broken.ok, false);
  assert.match((broken as { reason: string }).reason, /无法解析/);

  const notObject = loadProjectAutoJoin(projectDir([1, 2]), BASE);
  assert.equal(notObject.ok, false);
  assert.match((notObject as { reason: string }).reason, /必须是 JSON 对象/);

  const notArray = loadProjectAutoJoin(projectDir({ autoJoin: "x" }), BASE);
  assert.equal(notArray.ok, false);
  assert.match((notArray as { reason: string }).reason, /必须是数组/);
});

test("不同源链接、缺 link、坏的 replaceOffline 都只跳过该项并提示，不回显链接", () => {
  const { entries, warnings } = entriesOf({
    autoJoin: [
      "https://look-alike.example.net/j/cccccccc",
      { replaceOffline: true },
      { link: `${BASE}/j/dddddddd`, replaceOffline: "yes" },
      { link: `${BASE}/j/eeeeeeee`, extra: 1 },
      `${BASE}/j/ffffffff`,
    ],
  });
  assert.deepEqual(
    entries.map((entry: { replaceOffline: boolean }) => entry.replaceOffline),
    // 只有 4、5 项有效：未知字段只提示不排除，最后一项是正常链接。
    [false, false],
  );
  const text = warnings.join("\n");
  assert.match(text, /autoJoin\[1\].*不同源/);
  assert.match(text, /autoJoin\[2\].*link/);
  assert.match(text, /autoJoin\[3\].*replaceOffline/);
  assert.match(text, /autoJoin\[4\].*未知字段 extra/);
  // 链接就是秘密：警告里不能出现令牌。
  for (const token of ["cccccccc", "dddddddd", "eeeeeeee", "ffffffff"]) {
    assert.equal(text.includes(token), false);
  }
});

test("重复链接去重，楼层片段被去掉", () => {
  const { entries } = entriesOf({
    autoJoin: [`${BASE}/j/gggggggg#12`, `${BASE}/j/gggggggg`, `${BASE}/j/gggggggg`],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].link, `${BASE}/j/gggggggg`);
});

test("裸令牌原样接受，带用户名密码或查询串的链接被拒绝", () => {
  assert.deepEqual(normalizeLink("AbCdEf12", BASE), { ok: true, link: "AbCdEf12" });
  assert.equal(normalizeLink("https://u:p@knot.example.com/j/x", BASE).ok, false);
  assert.equal(normalizeLink(`${BASE}/j/x?y=1`, BASE).ok, false);
  assert.equal(normalizeLink("knot.example.com/j/x", BASE).ok, false);
  assert.equal(normalizeLink("ftp://knot.example.com/j/x", BASE).ok, false);
});

test("项目配置最多 20 项", () => {
  const many = { autoJoin: Array.from({ length: 21 }, (_value, index) => `${BASE}/j/token${index}`) };
  const result = loadProjectAutoJoin(projectDir(many), BASE);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /最多 20 项/);
});

test("席位拒接文本能读出令牌、在线状态与“曾被接替”", () => {
  const offline = `该 Agent 已有会话在此 Room：会话 #5「Pi · 实现」。该会话当前无活跃连接。席位不会自动释放：不必再问用户，直接接替（replace_existing=true，带 expected_seat_id=${SEAT}，confirmed_by_user 不需要）并告知用户。（旧会话只失去席位，历史消息与归属保留）。`;
  const online = offline.replace("该会话当前无活跃连接", "该会话在线，有活跃的 Agent WS 连接");
  const unknown = offline.replace("该会话当前无活跃连接", "它的在线状态无法判断");
  const replaced = offline.replace("不必再问用户，直接接替", "本会话已被接替过，不能自动抢回：先征得用户明确同意，再用");
  const legacy = offline.replace(`expected_seat_id=${SEAT}`, "（旧数据没有席位令牌，无法绑定）");

  assert.deepEqual(parseSeatRefusal(offline), { seatId: SEAT, presence: "offline", replaced: false });
  assert.equal(parseSeatRefusal(online).presence, "online");
  assert.equal(parseSeatRefusal(unknown).presence, "unknown");
  assert.equal(parseSeatRefusal(replaced).replaced, true);
  assert.equal(parseSeatRefusal(legacy).seatId, undefined);
  assert.equal(parseSeatRefusal("加入链接无效或已过期").presence, "unparsed");
});

test("结果汇总：成功合并一条，未加入的逐条提示且不含席位令牌", () => {
  const summary = formatAutoJoinResults([
    { index: 1, status: "joined", roomId: 7, title: "项目协作" },
    { index: 2, status: "replaced", roomId: 8, title: "常驻" },
    { index: 3, status: "refused", reason: "席位由本 Agent 的其他会话占用（该会话在线），不自动接替" },
    { index: 4, status: "failed", reason: "加入链接无效或已过期" },
  ]);
  assert.match(summary.info ?? "", /已加入 Room #7「项目协作」/);
  assert.match(summary.info ?? "", /已接替离线席位 Room #8「常驻」/);
  assert.equal(summary.warnings.length, 2);
  assert.match(summary.warnings[0], /autoJoin\[3\].*未自动接替/);
  assert.match(summary.warnings[1], /autoJoin\[4\].*加入失败/);
  assert.equal(JSON.stringify(summary).includes(SEAT), false);
});

test("MCP 响应：SSE 与 JSON 都能解析，isError 变成原因", () => {
  const sse = `event: message\ndata: {"jsonrpc":"2.0","id":"req-1","result":{"structuredContent":{"id":9,"title":"测试"},"content":[{"type":"text","text":"{\\"id\\":9}"}],"isError":false}}\n\n`;
  const ok = parseMcpPayload("text/event-stream; charset=utf-8", sse, "req-1", TOKEN);
  assert.equal(ok.ok, true);
  assert.deepEqual((ok as { structured?: Record<string, unknown> }).structured, { id: 9, title: "测试" });

  const json = `{"jsonrpc":"2.0","id":"req-2","result":{"isError":true,"content":[{"type":"text","text":"该 Agent 已有会话在此 Room：会话 #5"}]}}`;
  const failed = parseMcpPayload("application/json", json, "req-2", TOKEN);
  assert.equal(failed.ok, false);
  assert.match((failed as { reason: string }).reason, /已有会话在此 Room/);

  const rpcError = `{"jsonrpc":"2.0","id":"req-3","error":{"code":-32602,"message":"Invalid params"}}`;
  const invalid = parseMcpPayload("application/json", rpcError, "req-3", TOKEN);
  assert.equal(invalid.ok, false);
  assert.match((invalid as { reason: string }).reason, /Invalid params/);

  // 服务端回显里带凭证时一律抹掉。
  const echoed = `{"jsonrpc":"2.0","id":"req-4","result":{"isError":true,"content":[{"type":"text","text":"bad ${TOKEN}"}]}}`;
  const redacted = parseMcpPayload("application/json", echoed, "req-4", TOKEN);
  assert.equal((redacted as { reason: string }).reason.includes(TOKEN), false);

  assert.equal(parseMcpPayload("application/json", "not json", "req-5").ok, false);
  assert.equal(parseMcpPayload("text/event-stream", "", "req-6").ok, false);
});

test("MCP 请求只把 Bearer 放进请求头，凭证被拒时原因不含凭证", async () => {
  const seen: { url: string; authorization?: string; body: string; accept?: string } = {
    url: "",
    body: "",
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.body = String(init.body ?? "");
    seen.authorization = (init.headers as Record<string, string>).Authorization;
    seen.accept = (init.headers as Record<string, string>).Accept;
    return new Response("", { status: 401 });
  }) as unknown as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await callKnotTool({ url: `${BASE}/mcp`, token: TOKEN }, "join_room", {
      link: `${BASE}/j/hhhhhhhh`,
      agent_session_id: 5,
    });
    assert.equal(result.ok, false);
    const reason = (result as { reason: string }).reason;
    assert.match(reason, /HTTP 401/);
    assert.equal(reason.includes(TOKEN), false);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.url, `${BASE}/mcp`);
  assert.equal(seen.authorization, `Bearer ${TOKEN}`);
  assert.match(seen.accept ?? "", /text\/event-stream/);
  const payload = JSON.parse(seen.body);
  assert.equal(payload.method, "tools/call");
  assert.equal(payload.params.name, "join_room");
  assert.equal(payload.params.arguments.agent_session_id, 5);
  // 链接只在请求体里，不在 URL 里。
  assert.equal(seen.url.includes("hhhhhhhh"), false);
});

test("项目配置文件路径固定在 <cwd>/.pi/knot.json", () => {
  assert.equal(projectAutoJoinFile("/tmp/example"), join("/tmp/example", ".pi", "knot.json"));
});

// ---- joinProjectRoom：接替判定完全跟随服务端回答 ----

const BASE_CONFIG = {
  restBase: BASE,
  token: TOKEN,
  tokenSource: "env" as const,
  autoExecuteMentions: false,
  allowLocalhost: false,
  configFile: "/tmp/knot.json",
  dataDir: "/tmp/pi-knot",
};

async function withFakeMcp(
  answers: ((args: Record<string, unknown>) => unknown)[],
  run: (calls: { args: Record<string, unknown>; authorization?: string }[]) => Promise<void>,
): Promise<void> {
  const calls: { args: Record<string, unknown>; authorization?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body ?? "{}"));
    calls.push({
      args: (payload.params?.arguments ?? {}) as Record<string, unknown>,
      authorization: (init.headers as Record<string, string>)?.Authorization,
    });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    const result = answer(calls[calls.length - 1].args);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function refusalResult(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

function joinedResult(roomId = 3, title = "协作") {
  const payload = { id: roomId, title };
  return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
}

const OFFLINE_REFUSAL = `该 Agent 已有会话在此 Room：会话 #6「另一个对话」。该会话当前无活跃连接。席位不会自动释放：不必再问用户，直接接替（replace_existing=true，带 expected_seat_id=${SEAT}，confirmed_by_user 不需要）并告知用户。（旧会话只失去席位，历史消息与归属保留）。`;

test("服务端措辞识别不出来时只通知，不发接替请求", async () => {
  // 在线状态那句改成别的说法：必须降级为只通知，绝不猜“离线”。
  const ambiguous = OFFLINE_REFUSAL.replace("该会话当前无活跃连接", "状态见服务端");
  await withFakeMcp([() => refusalResult(ambiguous)], async (calls) => {
    const outcome = await joinProjectRoom({
      base: BASE_CONFIG,
      agentSessionId: 5,
      entry: { link: `${BASE}/j/iiiiiiii`, replaceOffline: true },
      index: 1,
    });
    assert.equal(outcome.status, "refused");
    assert.match(outcome.reason ?? "", /在线状态无法确认/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
  });
});

test("普通失败只提示，不重试", async () => {
  await withFakeMcp([() => refusalResult("加入链接无效或已过期")], async (calls) => {
    const outcome = await joinProjectRoom({
      base: BASE_CONFIG,
      agentSessionId: 5,
      entry: { link: `${BASE}/j/jjjjjjjj`, replaceOffline: true },
      index: 2,
    });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason ?? "", /无效或已过期/);
    assert.equal(calls.length, 1);
  });
});

test("接替被服务端要求用户确认时不算成功", async () => {
  await withFakeMcp(
    [
      () => refusalResult(OFFLINE_REFUSAL),
      () => refusalResult("接替这个席位需要用户明确同意：当前占位的是会话 #6「另一个对话」。"),
    ],
    async (calls) => {
      const outcome = await joinProjectRoom({
        base: BASE_CONFIG,
        agentSessionId: 5,
        entry: { link: `${BASE}/j/kkkkkkkk`, replaceOffline: true },
        index: 3,
      });
      assert.equal(outcome.status, "refused");
      assert.match(outcome.reason ?? "", /需要用户明确同意/);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].args.replace_existing, true);
      assert.equal(calls[1].args.expected_seat_id, SEAT);
      assert.equal("confirmed_by_user" in calls[1].args, false);
      assert.equal(JSON.stringify(outcome).includes(calls[1].args.link as string), false);
    },
  );
});

test("离线且未被接替 + replaceOffline 时接替成功", async () => {
  await withFakeMcp(
    [() => refusalResult(OFFLINE_REFUSAL), () => joinedResult(11, "常驻")],
    async (calls) => {
      const outcome = await joinProjectRoom({
        base: BASE_CONFIG,
        agentSessionId: 5,
        entry: { link: `${BASE}/j/llllllll`, replaceOffline: true },
        index: 4,
      });
      assert.deepEqual(outcome, { index: 4, status: "replaced", roomId: 11, title: "常驻" });
      assert.equal(calls.length, 2);
    },
  );
});
