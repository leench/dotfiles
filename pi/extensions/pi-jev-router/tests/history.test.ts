import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_HISTORY_TURNS,
  collectRecentHistory,
  createEvaluationInput,
  formatDecisionLine,
  formatFailureLine,
  messageText,
  type HistoryTurn,
} from "../src/history.ts";

function userEntry(text: string) {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEntry(blocks: unknown[]) {
  return { type: "message", message: { role: "assistant", content: blocks } };
}

const textBlock = (text: string) => ({ type: "text", text });
const toolCall = { type: "toolCall", id: "call-1", name: "bash", arguments: {} };
const thinking = { type: "thinking", thinking: "先想一下" };

test("extracts only user and assistant text blocks", () => {
  assert.equal(messageText({ role: "user", content: "  你好  " }), "你好");
  assert.equal(
    messageText({
      role: "assistant",
      content: [thinking, toolCall, textBlock("调查完成"), { type: "image", data: "", mimeType: "image/png" }],
    }),
    "调查完成",
  );
  assert.equal(messageText({ role: "assistant", content: [thinking, toolCall] }), "");
  assert.equal(messageText({ role: "toolResult", content: [textBlock("bash 输出")] }), "bash 输出");
  assert.equal(messageText(undefined), "");
});

test("keeps at most the three most recent complete turns, oldest first", () => {
  assert.equal(MAX_HISTORY_TURNS, 3);
  const entries = [
    userEntry("问题 1"),
    assistantEntry([textBlock("结论 1")]),
    userEntry("问题 2"),
    assistantEntry([textBlock("结论 2")]),
    userEntry("问题 3"),
    assistantEntry([textBlock("结论 3")]),
    userEntry("问题 4"),
    assistantEntry([textBlock("结论 4")]),
  ];

  assert.deepEqual(collectRecentHistory(entries), [
    { user: "问题 2", assistant: "结论 2" },
    { user: "问题 3", assistant: "结论 3" },
    { user: "问题 4", assistant: "结论 4" },
  ]);
});

test("pairs each user message with the last assistant message containing text", () => {
  const entries = [
    { type: "compaction", summary: "早期摘要" },
    userEntry("重构 X"),
    assistantEntry([textBlock("我先看一下代码"), toolCall]),
    { type: "message", message: { role: "toolResult", toolName: "bash", content: [textBlock("文件列表")] } },
    assistantEntry([thinking, toolCall]),
    assistantEntry([textBlock("最终答复 A")]),
    userEntry("再看 Y"),
    assistantEntry([textBlock("最终答复 B")]),
  ];

  assert.deepEqual(collectRecentHistory(entries), [
    { user: "重构 X", assistant: "最终答复 A" },
    { user: "再看 Y", assistant: "最终答复 B" },
  ]);
});

test("ignores turns without a final assistant answer", () => {
  const entries = [
    userEntry("已完成的问题"),
    assistantEntry([textBlock("已完成答复")]),
    userEntry("被中断的问题"),
    assistantEntry([thinking]),
  ];

  assert.deepEqual(collectRecentHistory(entries), [{ user: "已完成的问题", assistant: "已完成答复" }]);
});

test("returns an empty history for an empty branch", () => {
  assert.deepEqual(collectRecentHistory([]), []);
});

test("puts the current prompt first and the history after it", () => {
  const history: HistoryTurn[] = [{ user: "旧问题", assistant: "旧结论" }];
  const input = createEvaluationInput("当前请求", history, 0, 10_000);

  assert.equal(
    input.state,
    "当前用户请求：\n当前请求\n\n最近对话（较早的内容在前）：\n用户：旧问题\n助手最终答复：旧结论",
  );
  assert.equal(input.inputChars, input.state.length);
  assert.equal(input.sentChars, input.state.length);
  assert.equal(input.truncated, false);
});

test("keeps the prompt-only input when there is no history", () => {
  const input = createEvaluationInput("  只发这一条  ", [], 0, 10_000);

  assert.deepEqual(input, {
    state: "只发这一条",
    inputChars: "只发这一条".length,
    sentChars: "只发这一条".length,
    truncated: false,
  });
});

test("keeps the image note for prompts with images", () => {
  const input = createEvaluationInput("看图", [], 2, 10_000);

  assert.equal(input.state, "看图\n\n[2 image attachments; image content is not sent to Jev.]");
  assert.equal(input.truncated, false);
});

const history: HistoryTurn[] = [
  { user: "第一轮问题", assistant: "第一轮结论" },
  { user: "第二轮问题", assistant: "第二轮结论" },
  { user: "第三轮问题", assistant: "第三轮结论" },
];
const prompt = "现在做什么";

function expectedState(turns: readonly HistoryTurn[]): string {
  if (turns.length === 0) return prompt;
  const lines = turns.map((turn) => `用户：${turn.user}\n助手最终答复：${turn.assistant}`).join("\n");
  return `当前用户请求：\n${prompt}\n\n最近对话（较早的内容在前）：\n${lines}`;
}

test("drops the oldest history turns first when the limit is exceeded", () => {
  const full = expectedState(history);

  assert.deepEqual(createEvaluationInput(prompt, history, 0, full.length), {
    state: full,
    inputChars: full.length,
    sentChars: full.length,
    truncated: false,
  });

  const oneDropped = createEvaluationInput(prompt, history, 0, full.length - 1);
  assert.equal(oneDropped.state, expectedState(history.slice(1)));
  assert.equal(oneDropped.inputChars, full.length);
  assert.equal(oneDropped.truncated, true);

  const twoDropped = createEvaluationInput(prompt, history, 0, expectedState(history.slice(2)).length);
  assert.equal(twoDropped.state, expectedState(history.slice(2)));
  assert.equal(twoDropped.truncated, true);

  const allDropped = createEvaluationInput(prompt, history, 0, prompt.length);
  assert.equal(allDropped.state, prompt);
  assert.equal(allDropped.sentChars, prompt.length);
  assert.equal(allDropped.truncated, true);
});

test("truncates the prompt only when it alone exceeds the limit, without history", () => {
  const longPrompt = "很长的请求".repeat(20);
  const input = createEvaluationInput(longPrompt, history, 0, 40);

  assert.equal(input.state.length, 40);
  assert.equal(input.state, longPrompt.slice(0, 40));
  assert.ok(!input.state.includes("最近对话"));
  assert.equal(input.truncated, true);
});

test("does not repeat the current prompt as the newest history turn", () => {
  const turns: HistoryTurn[] = [
    { user: "你好", assistant: "你好，有什么可以帮你？" },
    { user: "现在做什么", assistant: "这是重放的旧答复" },
  ];
  const input = createEvaluationInput("现在做什么", turns, 0, 10_000);

  assert.ok(input.state.includes("助手最终答复：你好，有什么可以帮你？"));
  assert.ok(!input.state.includes("这是重放的旧答复"));
});

test("formats the decision line with the selected route first", () => {
  const probabilities = { direct: 0.3, scout: 0.6712, worker: 0.01, scout_worker: 0.02 };

  assert.equal(
    formatDecisionLine("suggest", "scout", probabilities),
    "Jev [Suggest] scout 67% · direct 30% · worker 1% · scout_worker 2%",
  );
  assert.equal(
    formatDecisionLine("shadow", "direct", probabilities),
    "Jev [Shadow] direct 30% · scout 67% · worker 1% · scout_worker 2%",
  );
});

test("formats a concise failure line", () => {
  assert.equal(formatFailureLine("suggest", "timeout"), "Jev [Suggest] 失败：timeout");
  assert.equal(formatFailureLine("shadow", "unexpected_error"), "Jev [Shadow] 失败：unexpected_error");
});
