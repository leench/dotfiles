import assert from "node:assert/strict";
import test from "node:test";
import { createProxyFetch } from "../src/proxy-fetch.ts";
import {
  callJev,
  createRequestBody,
  DEFAULT_MODEL_ID,
  JevRequestError,
  parseJevResponse,
  ROUTES,
  ROUTE_CRITERIA,
  ROUTE_EXECUTION_INSTRUCTIONS,
  SYSTEMONE_ENDPOINT,
} from "../src/jev-client.ts";

const validResponse = {
  model: "jev-1.13-free",
  answers: {
    route: {
      type: "choice",
      choice: "scout",
      probabilities: {
        direct: 0.1,
        scout: 0.8,
        worker: 0.1,
      },
      confidence: 0.6,
    },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
};

test("creates fetch clients for HTTP and SOCKS5 proxies", () => {
  for (const proxyUrl of [
    "http://127.0.0.1:7890",
    "https://proxy.example:8443",
    "socks5://127.0.0.1:1080",
    "socks5h://127.0.0.1:1080",
  ]) {
    assert.equal(typeof createProxyFetch(proxyUrl), "function");
  }
});

test("creates a System One choice request with the three supported routes", () => {
  const body = createRequestBody("test task");
  assert.equal(body.model, DEFAULT_MODEL_ID);
  assert.equal(body.state, "test task");
  assert.deepEqual(Object.keys(body.questions.route.criteria), [...ROUTES]);
  assert.equal(body.questions.route.type, "choice");
});

test("gives each route an explicit execution instruction", () => {
  assert.match(ROUTE_EXECUTION_INSTRUCTIONS.direct, /不要调用 subagent/);
  assert.match(ROUTE_EXECUTION_INSTRUCTIONS.scout, /只读调查/);
  assert.match(ROUTE_EXECUTION_INSTRUCTIONS.scout, /不得修改文件、提交、推送/);
  for (const route of ["scout", "worker"] as const) {
    assert.match(ROUTE_EXECUTION_INSTRUCTIONS[route], /显式设置 async: true/);
    assert.match(ROUTE_EXECUTION_INSTRUCTIONS[route], /不要同步等待或调用 subagent_wait/);
    assert.match(ROUTE_EXECUTION_INSTRUCTIONS[route], /用户明确要求前台执行或等待结果时才使用 async: false/);
    assert.match(ROUTE_EXECUTION_INSTRUCTIONS[route], /不要在结果返回前声称任务已完成/);
  }
  assert.match(ROUTE_EXECUTION_INSTRUCTIONS.worker, /实际调用.*subagent.*worker/s);
  assert.deepEqual(Object.keys(ROUTE_EXECUTION_INSTRUCTIONS), [...ROUTES]);
});

test("routes side-effecting implementation and git operations away from scout", () => {
  assert.match(ROUTE_CRITERIA.scout, /只读侦察/);
  assert.match(ROUTE_CRITERIA.scout, /不需要修改文件或执行有副作用的命令/);
  assert.match(ROUTE_CRITERIA.worker, /文件修改、提交或推送/);
});

test("parses the documented choice, probabilities, confidence and usage", () => {
  assert.deepEqual(parseJevResponse(validResponse), {
    route: "scout",
    probabilities: { direct: 0.1, scout: 0.8, worker: 0.1 },
    confidence: 0.6,
    responseModel: "jev-1.13-free",
    inputTokens: 123,
    outputTokens: 0,
  });
});

test("rejects unsupported choices and malformed probability values", () => {
  for (const choice of ["planner", "scout_worker"]) {
    assert.throws(
      () => parseJevResponse({ answers: { route: { ...validResponse.answers.route, choice } } }),
      JevRequestError,
    );
  }
  assert.throws(
    () => parseJevResponse({ answers: { route: { ...validResponse.answers.route, probabilities: { direct: 1 } } } }),
    JevRequestError,
  );
});

test("calls the dedicated endpoint with bearer auth and parses the response", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const result = await callJev({
    apiKey: "test-secret",
    state: "test task",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify(validResponse), { status: 200 });
    },
  });

  assert.equal(requestUrl, SYSTEMONE_ENDPOINT);
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer test-secret");
  assert.equal(result.route, "scout");
});

test("does not include an HTTP error body in its error", async () => {
  await assert.rejects(
    callJev({
      apiKey: "test-secret",
      state: "test task",
      fetchImpl: async () => new Response("private upstream details", { status: 401 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof JevRequestError);
      assert.equal(error.code, "http_401");
      assert.doesNotMatch(error.message, /private upstream details|test-secret/);
      return true;
    },
  );
});

test("times out a stalled request", async () => {
  await assert.rejects(
    callJev({
      apiKey: "test-secret",
      state: "test task",
      timeoutMs: 10,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    }),
    (error: unknown) => error instanceof JevRequestError && error.code === "timeout",
  );
});
