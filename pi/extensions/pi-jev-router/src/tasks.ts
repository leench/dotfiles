import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_STATE_CHARS = 4_000;
const TASKS_FILE = fileURLToPath(new URL("../tests/fixtures/tasks.json", import.meta.url));

export interface FixedTask {
  id: string;
  state: string;
}

export function loadFixedTasks(): FixedTask[] {
  const value: unknown = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
  if (typeof value !== "object" || value === null || !Array.isArray((value as { tasks?: unknown }).tasks)) {
    throw new Error("固定测试集格式无效：缺少 tasks 数组");
  }

  const tasks = (value as { tasks: unknown[] }).tasks;
  const ids = new Set<string>();
  return tasks.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`固定测试集第 ${index + 1} 项格式无效`);
    }
    const task = item as Record<string, unknown>;
    if (
      typeof task.id !== "string" ||
      !/^[a-z0-9-]+$/.test(task.id) ||
      ids.has(task.id) ||
      typeof task.state !== "string" ||
      task.state.trim().length === 0 ||
      task.state.length > MAX_STATE_CHARS
    ) {
      throw new Error(`固定测试集第 ${index + 1} 项缺少有效且唯一的 id/state`);
    }
    ids.add(task.id);
    return { id: task.id, state: task.state };
  });
}
