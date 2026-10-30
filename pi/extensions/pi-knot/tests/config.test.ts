import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bindSession, loadConfig, resolveAgentDir } from "../src/config.ts";

const TOKEN = "test-token-0123456789abcdef";

function agentDir(values?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-knot-config-"));
  if (values) {
    writeFileSync(join(dir, "knot.json"), `${JSON.stringify(values)}\n`);
  }
  return dir;
}

function withToken(dir: string, token = TOKEN): Record<string, string> {
  return { PI_CODING_AGENT_DIR: dir, KNOT_AGENT_TOKEN: token };
}

test("缺少配置文件与环境变量时视为未配置", () => {
  const dir = agentDir();
  const result = loadConfig({ PI_CODING_AGENT_DIR: dir });
  assert.equal(result.ok, false);
  assert.equal((result as { missing: boolean }).missing, true);
  assert.match((result as { reason: string }).reason, /knot\.json/);
});

test("配置缺 Token 时不连接并提示环境变量", () => {
  const dir = agentDir({ restUrl: "https://knot.example.com", agentSessionId: 5 });
  const result = loadConfig({ PI_CODING_AGENT_DIR: dir });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /KNOT_AGENT_TOKEN/);
});

test("生产环境必须是 HTTPS/WSS", () => {
  const dir = agentDir({ restUrl: "http://knot.example.com", agentSessionId: 5 });
  const result = loadConfig(withToken(dir));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /HTTPS/);
});

test("localhost 需要显式 allowLocalhost，并给出明文提示", () => {
  const blocked = loadConfig(withToken(agentDir({ restUrl: "http://127.0.0.1:8080", agentSessionId: 5 })));
  assert.equal(blocked.ok, false);
  assert.match((blocked as { reason: string }).reason, /allowLocalhost/);

  const allowedDir = agentDir({ restUrl: "http://127.0.0.1:8080", agentSessionId: 5, allowLocalhost: true });
  const allowed = loadConfig(withToken(allowedDir));
  assert.equal(allowed.ok, true);
  const base = (allowed as { config: { restBase: string }; warnings: string[] }).config;
  assert.equal(base.restBase, "http://127.0.0.1:8080");
  assert.equal(bindSession(base as never, 5).wsUrl, "ws://127.0.0.1:8080/ws/agent-sessions/5");
  assert.match((allowed as { warnings: string[] }).warnings.join(""), /localhost/);
});

test("非 localhost 的内网明文地址不会被 allowLocalhost 放行", () => {
  const dir = agentDir({ restUrl: "http://192.168.1.10:8080", agentSessionId: 5, allowLocalhost: true });
  const result = loadConfig(withToken(dir));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /HTTPS/);
});

test("REST 地址不允许 userinfo、查询串或片段", () => {
  for (const restUrl of [
    "https://user:pass@knot.example.com",
    "https://knot.example.com/?token=secret",
    "https://knot.example.com/#frag",
  ]) {
    const result = loadConfig(withToken(agentDir({ restUrl, agentSessionId: 5 })));
    assert.equal(result.ok, false, restUrl);
    assert.doesNotMatch((result as { reason: string }).reason, /secret/);
  }
});

test("WS 地址由绑定的会话 ID 推导，配置文件里的 wsUrl 被忽略", () => {
  const result = loadConfig(
    withToken(
      agentDir({
        restUrl: "https://knot.example.com",
        wsUrl: "wss://other.example.com/ws/agent-sessions/6",
        agentSessionId: 5,
      }),
    ),
  );
  assert.equal(result.ok, true);
  const { config, warnings } = result as { config: never; warnings: string[] };
  // 绝不能因为旧 wsUrl 把连接导向别的 host 或别的会话路径。
  assert.equal(bindSession(config, 5).wsUrl, "wss://knot.example.com/ws/agent-sessions/5");
  // 旧 wsUrl 已被忽略是正常回退，不再作为启动警告。
  assert.equal(warnings.join("").includes("wsUrl"), false);
});

test("不提供 REST 地址但给出 WS 地址时，仍要求完整配置", () => {
  const result = loadConfig(withToken(agentDir({ wsUrl: "wss://knot.example.com/ws/agent-sessions/5", agentSessionId: 5 })));
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /KNOT_REST_URL/);
});

test("环境变量提供凭证时，knot.json 里的 token 字段被忽略并告警", () => {
  const dir = agentDir({
    restUrl: "https://knot.example.com",
    agentSessionId: 5,
    token: "file-token-should-be-ignored",
  });
  const result = loadConfig(withToken(dir));
  assert.equal(result.ok, true);
  const { config, warnings } = result as { config: { token: string }; warnings: string[] };
  assert.equal(config.token, TOKEN);
  assert.match(warnings.join(""), /token/);
});

test("Token 格式错误时拒绝，且错误信息不含 Token 内容", () => {
  for (const token of ["bad token", "bad\ntoken", "带中文"]) {
    const result = loadConfig(withToken(agentDir({ restUrl: "https://knot.example.com", agentSessionId: 5 }), token));
    assert.equal(result.ok, false, token);
    const reason = (result as { reason: string }).reason;
    assert.doesNotMatch(reason, /bad|中文/);
    assert.match(reason, /KNOT_AGENT_TOKEN/);
  }
});

test("环境变量覆盖配置文件", () => {
  const dir = agentDir({ restUrl: "https://file.example.com", agentSessionId: 5 });
  const result = loadConfig({
    PI_CODING_AGENT_DIR: dir,
    KNOT_AGENT_TOKEN: TOKEN,
    KNOT_REST_URL: "https://env.example.com",
    KNOT_AGENT_SESSION_ID: "7",
  });
  assert.equal(result.ok, true);
  const base = (result as { config: { restBase: string; legacySessionId?: number }; warnings: string[] }).config;
  assert.equal(base.restBase, "https://env.example.com");
  // 旧环境变量只作为“可显式选用的 ID”保留，不再自动生效；
  assert.equal(base.legacySessionId, 7);
  // 旧 ID 不自动生效是正常回退，不再作为启动警告（/knot status 仍会说明）。
  assert.equal((result as { warnings: string[] }).warnings.join("").includes("/knot connect"), false);
  // 显式选用时 WS 路径也随该 ID 推导。
  assert.equal(bindSession(base as never, 7).wsUrl, "wss://env.example.com/ws/agent-sessions/7");
});

test("健康检查地址包含路径前缀时保留前缀", () => {
  const dir = agentDir({ restUrl: "https://knot.example.com/prefix/", agentSessionId: 5 });
  const result = loadConfig(withToken(dir));
  assert.equal(result.ok, true);
  const config = (result as { config: { restBase: string } }).config;
  assert.equal(config.restBase, "https://knot.example.com/prefix");
  assert.equal(bindSession(config as never, 5).wsUrl, "wss://knot.example.com/prefix/ws/agent-sessions/5");
});

test("会话 ID 与规范化服务地址隔离游标目录", () => {
  const first = loadConfig(withToken(agentDir({ restUrl: "https://knot.example.com", agentSessionId: 5 })));
  const second = loadConfig(withToken(agentDir({ restUrl: "https://knot.example.com", agentSessionId: 6 })));
  const other = loadConfig(withToken(agentDir({ restUrl: "https://other.example.com", agentSessionId: 5 })));
  const firstConfig = bindSession((first as { config: never }).config, 5);
  const secondConfig = bindSession((second as { config: never }).config, 6);
  const otherConfig = bindSession((other as { config: never }).config, 5);
  assert.notEqual(firstConfig.serviceKey, secondConfig.serviceKey);
  assert.notEqual(firstConfig.serviceKey, otherConfig.serviceKey);
  assert.notEqual(firstConfig.stateDir, secondConfig.stateDir);
  assert.doesNotMatch(firstConfig.stateDir, /test-token/);
});


// ---- 凭证来源：环境变量优先，其次用户级 mcp.json 的 knot HTTP 条目 ----

const MCP_TOKEN = "mcp-bearer-token-0123456789";
const REST = "https://knot.example.com";

function mcpAgent(entry: unknown, extraServers: Record<string, unknown> = {}): string {
  const dir = agentDir({ restUrl: REST, agentSessionId: 5 });
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({ mcpServers: { knot: entry, ...extraServers } }, null, 2),
  );
  return dir;
}

function loadFrom(dir: string, extraEnv: Record<string, string> = {}) {
  return loadConfig({ PI_CODING_AGENT_DIR: dir, ...extraEnv });
}

test("未设置环境变量时复用用户级 mcp.json 的静态 Bearer", () => {
  const dir = mcpAgent({ url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
  const result = loadFrom(dir);
  assert.equal(result.ok, true);
  const { config, warnings } = result as { config: { token: string; tokenSource: string }; warnings: string[] };
  assert.equal(config.token, MCP_TOKEN);
  assert.equal(config.tokenSource, "mcp-json");
  // 复用用户级 mcp.json 是正常路径，不再产生启动警告。
  assert.equal(warnings.join("").includes("复用用户级"), false);
  assert.equal(warnings.join("").includes(MCP_TOKEN), false);
});

test("Authorization 头名大小写不敏感，Bearer 关键字也大小写不敏感", () => {
  for (const key of ["Authorization", "authorization", "AUTHORIZATION"]) {
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const dir = mcpAgent({ url: `${REST}/mcp`, headers: { [key]: `${scheme} ${MCP_TOKEN}` } });
      const result = loadFrom(dir);
      assert.equal(result.ok, true, `${key} / ${scheme}`);
      assert.equal((result as { config: { token: string } }).config.token, MCP_TOKEN);
    }
  }
});

test("Authorization 里的 \${VAR} 做纯环境替换", () => {
  const dir = mcpAgent({ url: `${REST}/mcp`, headers: { Authorization: "Bearer \${KNOT_MCP_TOKEN}" } });
  const result = loadFrom(dir, { KNOT_MCP_TOKEN: MCP_TOKEN });
  assert.equal(result.ok, true);
  assert.equal((result as { config: { token: string } }).config.token, MCP_TOKEN);
});

test("未定义的环境变量报错，且不执行命令、不回显值", () => {
  const unresolved = mcpAgent({ url: `${REST}/mcp`, headers: { Authorization: "Bearer \${NOPE_TOKEN}" } });
  const bad = loadFrom(unresolved);
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /NOPE_TOKEN/);

  const command = mcpAgent({
    url: `${REST}/mcp`,
    headers: { Authorization: "!echo Bearer should-not-run" },
  });
  const rejected = loadFrom(command);
  assert.equal(rejected.ok, false);
  assert.match((rejected as { reason: string }).reason, /!command/);
  assert.equal((rejected as { reason: string }).reason.includes("should-not-run"), false);
});

test("环境变量优先于 mcp.json", () => {
  const dir = mcpAgent({ url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
  const result = loadConfig({ PI_CODING_AGENT_DIR: dir, KNOT_AGENT_TOKEN: TOKEN });
  assert.equal(result.ok, true);
  const { config, warnings } = result as { config: { token: string; tokenSource: string }; warnings: string[] };
  assert.equal(config.token, TOKEN);
  assert.equal(config.tokenSource, "env");
  assert.equal(warnings.join("").includes("复用用户级"), false);
});

test("环境变量已设置但无效时失败，不会偷偷回退到 mcp.json", () => {
  const dir = mcpAgent({ url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
  const result = loadConfig({ PI_CODING_AGENT_DIR: dir, KNOT_AGENT_TOKEN: "bad token" });
  assert.equal(result.ok, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /KNOT_AGENT_TOKEN/);
  assert.equal(reason.includes(MCP_TOKEN), false);
  assert.equal(reason.includes("bad token"), false);
});

test("mcp.json 的 knot 条目必须与 REST 同源", () => {
  const dir = mcpAgent({ url: "https://other.example.com/mcp", headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
  const result = loadFrom(dir);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /不同源/);
  assert.equal((result as { reason: string }).reason.includes(MCP_TOKEN), false);
});

test("禁用的、stdio 的、缺 Authorization 的 knot 条目都不能提供凭证", () => {
  const cases: { entry: unknown; pattern: RegExp }[] = [
    { entry: { url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` }, enabled: false }, pattern: /禁用/ },
    { entry: { command: "node", args: ["server.js"] }, pattern: /stdio/ },
    { entry: { type: "stdio", url: `${REST}/mcp`, headers: {} }, pattern: /stdio/ },
    { entry: { type: "sse", url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } }, pattern: /HTTP/ },
    { entry: { url: `${REST}/mcp` }, pattern: /Authorization/ },
    { entry: { url: `${REST}/mcp`, headers: {} }, pattern: /Authorization/ },
    { entry: { url: `${REST}/mcp`, headers: { Authorization: "Basic abc" } }, pattern: /Bearer/ },
    { entry: { url: `${REST}/mcp`, headers: { Authorization: MCP_TOKEN } }, pattern: /非空字符串|Bearer/ },
    { entry: { url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN} extra` } }, pattern: /Bearer/ },
    { entry: { url: `${REST}/mcp`, oauth: { clientId: "x" } }, pattern: /OAuth/ },
    { entry: { url: "https://user:pass@knot.example.com/mcp", headers: { Authorization: `Bearer ${MCP_TOKEN}` } }, pattern: /用户名或密码/ },
    { entry: { url: "not a url", headers: { Authorization: `Bearer ${MCP_TOKEN}` } }, pattern: /合法 URL/ },
  ];
  for (const item of cases) {
    const result = loadFrom(mcpAgent(item.entry));
    assert.equal(result.ok, false, JSON.stringify(item.entry));
    assert.match((result as { reason: string }).reason, item.pattern, JSON.stringify(item.entry));
    assert.equal((result as { reason: string }).reason.includes(MCP_TOKEN), false);
  }
});

test("缺少 knot 条目或其他 MCP 服务的凭证不能复用", () => {
  const dir = agentDir({ restUrl: REST, agentSessionId: 5 });
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: { other: { url: `${REST}/other`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } } },
    }),
  );
  const result = loadFrom(dir);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /没有 mcpServers\.knot/);
  assert.equal((result as { reason: string }).reason.includes(MCP_TOKEN), false);
});

test("mcp.json 损坏时失败且不回显文件内容", () => {
  const dir = agentDir({ restUrl: REST, agentSessionId: 5 });
  writeFileSync(join(dir, "mcp.json"), `{"mcpServers":{"knot":{"headers":{"Authorization":"Bearer ${MCP_TOKEN}"}}`);
  const result = loadFrom(dir);
  assert.equal(result.ok, false);
  const reason = (result as { reason: string }).reason;
  assert.match(reason, /无法解析/);
  assert.equal(reason.includes(MCP_TOKEN), false);
});

test("只读用户级 mcp.json：项目级 .pi/mcp.json 不能提供凭证", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-knot-project-"));
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { knot: { url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } } } }),
  );
  const dir = agentDir({ restUrl: REST, agentSessionId: 5 });
  const result = loadFrom(dir);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /未找到 Knot 凭证/);
  assert.equal((result as { reason: string }).reason.includes(MCP_TOKEN), false);
});

test("复用 mcp.json 的 Token 不进入状态目录、服务摘要或提示", () => {
  const dir = mcpAgent({ url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } });
  const result = loadFrom(dir);
  assert.equal(result.ok, true);
  const bound = bindSession((result as { config: never }).config, 5);
  const { config, warnings } = result as {
    config: { restBase: string };
    warnings: string[];
  };
  assert.equal(bound.stateDir.includes(MCP_TOKEN), false);
  assert.equal(bound.serviceKey.includes(MCP_TOKEN), false);
  assert.equal(config.restBase.includes(MCP_TOKEN), false);
  assert.equal(warnings.join("").includes(MCP_TOKEN), false);
});


test("autoExecuteMentions 默认关闭，显式 true 才开启", () => {
  const off = loadFrom(mcpAgent({ url: `${REST}/mcp`, headers: { Authorization: `Bearer ${MCP_TOKEN}` } }));
  assert.equal(off.ok, true);
  assert.equal((off as { config: { autoExecuteMentions: boolean } }).config.autoExecuteMentions, false);

  const dir = agentDir({ restUrl: REST, agentSessionId: 5, autoExecuteMentions: true });
  const on = loadConfig({ PI_CODING_AGENT_DIR: dir, KNOT_AGENT_TOKEN: TOKEN });
  assert.equal(on.ok, true);
  assert.equal((on as { config: { autoExecuteMentions: boolean } }).config.autoExecuteMentions, true);
});

test("autoExecuteMentions 不是布尔值时拒绝启动", () => {
  const dir = agentDir({ restUrl: REST, agentSessionId: 5, autoExecuteMentions: "yes" });
  const result = loadConfig({ PI_CODING_AGENT_DIR: dir, KNOT_AGENT_TOKEN: TOKEN });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /autoExecuteMentions/);
});

test("PI_CODING_AGENT_DIR 支持 ~ 展开", () => {
  assert.match(resolveAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }), /custom$/);
  assert.match(resolveAgentDir({}), /\.pi\/agent$/);
});
