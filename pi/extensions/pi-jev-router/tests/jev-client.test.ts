import assert from "node:assert/strict";
import test from "node:test";
import {
  callJev,
  createRequestBody,
  DEFAULT_MODEL_ID,
  JevRequestError,
  parseJevResponse,
  ROUTES,
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
        scout: 0.7,
        worker: 0.1,
        scout_worker: 0.1,
      },
      confidence: 0.6,
    },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
};

test("creates a System One choice request with all four route criteria", () => {
  const body = createRequestBody("test task");
  assert.equal(body.model, DEFAULT_MODEL_ID);
  assert.equal(body.state, "test task");
  assert.deepEqual(Object.keys(body.questions.route.criteria), [...ROUTES]);
  assert.equal(body.questions.route.type, "choice");
});

test("parses the documented choice, probabilities, confidence and usage", () => {
  assert.deepEqual(parseJevResponse(validResponse), {
    route: "scout",
    probabilities: { direct: 0.1, scout: 0.7, worker: 0.1, scout_worker: 0.1 },
    confidence: 0.6,
    responseModel: "jev-1.13-free",
    inputTokens: 123,
    outputTokens: 0,
  });
});

test("rejects unknown choices and malformed probability values", () => {
  assert.throws(
    () => parseJevResponse({ answers: { route: { ...validResponse.answers.route, choice: "planner" } } }),
    JevRequestError,
  );
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
