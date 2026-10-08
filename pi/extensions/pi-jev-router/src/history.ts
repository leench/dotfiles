/**
 * Jev 输入组装（当前 prompt + 最近对话）以及写入会话的结果文本。
 * 这两块都是纯函数，便于直接测试。
 */
import { ROUTES, type Route } from "./jev-client.ts";

/** 每次评估附加的历史轮数上限（固定值，不提供配置）。 */
export const MAX_HISTORY_TURNS = 3;

export interface HistoryTurn {
  user: string;
  assistant: string;
}

export interface EvaluationInput {
  state: string;
  inputChars: number;
  sentChars: number;
  truncated: boolean;
}

/** 读取历史所需的消息条目最小结构；SessionEntry 在结构上兼容。 */
export interface MessageEntryLike {
  type: string;
  message?: { role?: unknown; content?: unknown };
}

/**
 * 只提取模型可见的纯文本：字符串 content 或 type === "text" 的内容块。
 * thinking、toolCall、toolResult、图片与自定义消息一律不进入历史。
 */
export function messageText(message: MessageEntryLike["message"]): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  return parts.join("\n").trim();
}

/**
 * 保留 branch 上最近的完整轮次（较早在前）。一轮 = 一条 user 消息 + 该 user 之后、
 * 下一个 user 之前最后一条含文本的 assistant 消息；缺少最终答复的轮次（被中断或仍在进行）不计入。
 */
export function collectRecentHistory(
  entries: readonly MessageEntryLike[],
  maxTurns = MAX_HISTORY_TURNS,
): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let user: string | undefined;
  let assistant = "";

  const closeTurn = () => {
    if (user !== undefined && assistant) turns.push({ user, assistant });
    user = undefined;
    assistant = "";
  };

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    if (entry.message.role === "user") {
      closeTurn();
      const text = messageText(entry.message);
      if (text) user = text;
    } else if (entry.message.role === "assistant") {
      const text = messageText(entry.message);
      if (text) assistant = text;
    }
  }
  closeTurn();

  return turns.slice(-maxTurns);
}

function formatHistory(turns: readonly HistoryTurn[]): string {
  return turns
    .map((turn) => `用户：${turn.user}\n助手最终答复：${turn.assistant}`)
    .join("\n");
}

/** 当前 prompt 放在最前，历史附在其后。 */
function joinInput(current: string, history: readonly HistoryTurn[]): string {
  if (history.length === 0) return current;
  return `当前用户请求：\n${current}\n\n最近对话（较早的内容在前）：\n${formatHistory(history)}`;
}

/**
 * 组装发送给 Jev 的 state。当前 prompt 优先级最高：超长时先丢最旧的历史轮次，
 * 只有在 prompt 自身超出上限时才截断 prompt，且此时不再携带任何历史。
 */
export function createEvaluationInput(
  prompt: string,
  history: readonly HistoryTurn[],
  imageCount: number,
  maxChars: number,
): EvaluationInput {
  const current = prompt.trim();
  const note =
    imageCount > 0
      ? `[${imageCount} image attachment${imageCount === 1 ? "" : "s"}; image content is not sent to Jev.]`
      : "";
  const currentBlock = note ? `${current}\n\n${note}` : current;

  // 重放同一 prompt 时，branch 末尾可能已经出现本轮，去掉重复的最新一轮。
  const turns = [...history];
  while (turns.length > 0 && turns[turns.length - 1]?.user === current) turns.pop();

  const full = joinInput(currentBlock, turns);
  let state = full;
  for (let dropped = 1; state.length > maxChars && dropped <= turns.length; dropped += 1) {
    state = joinInput(currentBlock, turns.slice(dropped));
  }
  if (state.length > maxChars) state = state.slice(0, maxChars);

  return {
    state,
    inputChars: full.length,
    sentChars: state.length,
    truncated: state.length < full.length,
  };
}

function modeLabel(mode: "suggest" | "shadow"): string {
  return mode === "suggest" ? "Suggest" : "Shadow";
}

/** 成功行：先显示选中的 route，其余按 ROUTES 顺序。 */
export function formatDecisionLine(
  mode: "suggest" | "shadow",
  route: Route,
  probabilities: Record<Route, number>,
): string {
  const ordered = [route, ...ROUTES.filter((candidate) => candidate !== route)];
  const parts = ordered.map((candidate) => `${candidate} ${Math.round(probabilities[candidate] * 100)}%`);
  return `Jev [${modeLabel(mode)}] ${parts.join(" · ")}`;
}

export function formatFailureLine(mode: "suggest" | "shadow", code: string): string {
  return `Jev [${modeLabel(mode)}] 失败：${code}`;
}
