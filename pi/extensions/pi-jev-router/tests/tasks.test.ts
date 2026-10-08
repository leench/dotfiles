import assert from "node:assert/strict";
import test from "node:test";
import { MAX_STATE_CHARS, loadFixedTasks } from "../src/tasks.ts";

test("loads eight uniquely identified, bounded fixed test tasks", () => {
  const tasks = loadFixedTasks();
  assert.equal(tasks.length, 8);
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.ok(tasks.every((task) => task.state.length <= MAX_STATE_CHARS));
});
