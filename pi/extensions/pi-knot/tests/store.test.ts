import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SnapshotError,
  StateLock,
  StateStore,
  acquireStateLock,
  bindingPath,
  checkBinding,
  lockPath,
  rememberBinding,
  requireBinding,
  reverseBindingPath,
  type StoredEvent,
} from "../src/store.ts";

function event(id: number, extra: Partial<StoredEvent> = {}): StoredEvent {
  return {
    eventId: id,
    type: "room.message",
    roomId: 1,
    messageId: 100 + id,
    seq: id,
    senderKind: "human",
    senderId: 2,
    senderName: "示例用户",
    summary: `summary-${id}`,
    createdAt: 1_000 + id,
    ...extra,
  };
}


function store_event_pending(): StoredEvent {
  return event(2, { type: "mention.pending", mentionId: 42, messageVersion: "b".repeat(64) });
}

function newStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "pi-knot-store-"));
  const store = new StateStore(join(root, "svc", "5"), "svc", 5);
  store.open();
  return store;
}

test("提交后游标与收件箱落盘，重启可恢复", () => {
  const store = newStore();
  assert.equal(store.commitEvents([event(1), event(2)]), 2);
  assert.equal(statSync(store.dir).mode & 0o777, 0o700, "状态目录权限应为 0700");
  assert.equal(statSync(store.file).mode & 0o777, 0o600, "快照文件权限应为 0600");
  assert.equal(store.cursor, 2);
  assert.equal(store.unreadCount(), 2);

  const reopened = new StateStore(store.dir, "svc", 5);
  reopened.open();
  assert.equal(reopened.cursor, 2);
  assert.equal(reopened.events.length, 2);
  assert.equal(reopened.unreadCount(), 2);
});

test("重复事件幂等，ID 间隙不影响游标", () => {
  const store = newStore();
  assert.equal(store.commitEvents([event(5), event(9), event(10)]), 3);
  assert.equal(store.cursor, 10);
  assert.deepEqual(
    store.events.map((item) => item.eventId),
    [5, 9, 10],
  );
  assert.equal(store.commitEvents([event(9), event(10)]), 0);
  assert.equal(store.cursor, 10);
  assert.equal(store.commitEvents([event(6)]), 0, "小于游标的迟到事件不重复入箱");
  assert.equal(store.commitEvents([event(12)]), 1);
  assert.equal(store.cursor, 12);
});

test("写入失败不推进游标，恢复后可重试", () => {
  const store = newStore();
  assert.equal(store.commitEvents([event(1)]), 1);
  chmodSync(store.dir, 0o500);
  try {
    assert.throws(() => store.commitEvents([event(2)]));
    assert.equal(store.cursor, 1, "落盘失败时内存游标不能前进");
    assert.equal(store.events.length, 1);
  } finally {
    chmodSync(store.dir, 0o700);
  }
  assert.equal(store.commitEvents([event(2)]), 1);
  assert.equal(store.cursor, 2);
});

test("损坏快照 fail closed，不删除也不覆盖", () => {
  const store = newStore();
  store.commitEvents([event(1)]);
  writeFileSync(store.file, "{not json");
  const reopened = new StateStore(store.dir, "svc", 5);
  assert.throws(() => reopened.open(), SnapshotError);
  assert.equal(readFileSync(store.file, "utf8"), "{not json");
});

test("游标落后于已保存事件时拒绝加载", () => {
  const store = newStore();
  store.commitEvents([event(1), event(2)]);
  const raw = JSON.parse(readFileSync(store.file, "utf8"));
  raw.cursor = 1;
  writeFileSync(store.file, JSON.stringify(raw));
  assert.throws(() => new StateStore(store.dir, "svc", 5).open(), SnapshotError);
});

test("快照与当前配置不一致时拒绝加载", () => {
  const store = newStore();
  store.commitEvents([event(1)]);
  assert.throws(() => new StateStore(store.dir, "other-service", 5).open(), SnapshotError);
  assert.throws(() => new StateStore(store.dir, "svc", 6).open(), SnapshotError);
});

test("标记已读不推进游标，且重启后保留", () => {
  const store = newStore();
  store.commitEvents([event(1), event(2)]);
  assert.equal(store.markRead(1), true);
  assert.equal(store.markRead(1), false);
  assert.equal(store.cursor, 2);
  assert.equal(store.unreadCount(), 1);

  const reopened = new StateStore(store.dir, "svc", 5);
  reopened.open();
  assert.equal(reopened.unreadCount(), 1);
  assert.ok(reopened.find(1)?.readAt);
});

test("本地锁互斥，只按 nonce 释放", () => {
  const store = newStore();
  const first = acquireStateLock(store.dir, "pi-1");
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }
  const second = acquireStateLock(store.dir, "pi-2");
  assert.equal(second.ok, false);
  assert.equal(second.ok ? undefined : second.holder?.piSessionId, "pi-1");

  new StateLock(lockPath(store.dir), "not-the-owner").release();
  assert.equal(existsSync(lockPath(store.dir)), true, "nonce 不匹配时不能删除别人的锁");

  first.lock.release();
  assert.equal(existsSync(lockPath(store.dir)), false);
});

test("同一批事件里的重复 ID 只保存一次，跨批重复也不会产生坏快照", () => {
  const store = newStore();
  assert.equal(store.commitEvents([event(5), event(5), event(5)]), 1);
  assert.equal(store.commitEvents([event(5), event(6), event(6)]), 1);
  assert.deepEqual(
    store.events.map((item) => item.eventId),
    [5, 6],
  );
  assert.equal(store.cursor, 6);

  const reopened = new StateStore(store.dir, "svc", 5);
  reopened.open();
  assert.deepEqual(
    reopened.events.map((item) => item.eventId),
    [5, 6],
  );
});

test("绑定：同一数字 ID 但不同服务也不能静默切换", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-knot-binding-service-"));
  const stateDir = join(dataDir, "svc-a", "5");
  mkdirSync(stateDir, { recursive: true });
  const context = { dataDir, stateDir, serviceKey: "svc-a", agentSessionId: 5, piSessionId: "pi-session-1" };
  rememberBinding(context);

  const otherServiceDir = join(dataDir, "svc-b", "5");
  mkdirSync(otherServiceDir, { recursive: true });
  assert.throws(
    () => checkBinding({ ...context, stateDir: otherServiceDir, serviceKey: "svc-b" }),
    /不能静默切换/,
  );
  assert.throws(
    () => requireBinding({ ...context, stateDir: otherServiceDir, serviceKey: "svc-b" }),
    /绑定|尚未/,
  );
});

test("命令绑定校验不会替未绑定的 Pi 会话创建绑定", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-knot-binding-required-"));
  const stateDir = join(dataDir, "svc", "5");
  mkdirSync(stateDir, { recursive: true });
  const context = { dataDir, stateDir, serviceKey: "svc", agentSessionId: 5, piSessionId: "pi-session-1" };

  assert.throws(() => requireBinding(context), /尚未绑定/);
  assert.equal(existsSync(bindingPath(stateDir)), false);
  assert.equal(existsSync(reverseBindingPath(dataDir, context.piSessionId)), false);

  rememberBinding(context);
  requireBinding(context);
  assert.throws(
    () => requireBinding({ ...context, piSessionId: "pi-session-2" }),
    /已绑定 Pi 会话/,
  );
});


// ---- 自动处理基线 / 投递状态 ----

function mentionEvent(id: number, extra: Partial<StoredEvent> = {}): StoredEvent {
  return event(id, {
    type: "mention.execute",
    mentionId: 40 + id,
    messageVersion: "a".repeat(64),
    ...extra,
  });
}

test("自动处理基线单独保存，不推进 processed cursor", () => {
  const store = newStore();
  store.commitEvents([event(1), event(2)]);
  store.setAuto({ armed: true, baseline: 90, armedAt: Date.now() });
  assert.equal(store.cursor, 2, "基线不能当成游标");
  assert.equal(store.auto?.baseline, 90);

  const reopened = new StateStore(store.dir, "svc", 5);
  reopened.open();
  assert.equal(reopened.cursor, 2);
  assert.equal(reopened.auto?.armed, true);
  assert.equal(reopened.auto?.baseline, 90);
});

test("旧 schema（没有 auto 字段）仍可加载既有收件箱", () => {
  const store = newStore();
  store.commitEvents([event(1), mentionEvent(2)]);
  const raw = JSON.parse(readFileSync(store.file, "utf8"));
  delete raw.auto;
  writeFileSync(store.file, JSON.stringify(raw));

  const reopened = new StateStore(store.dir, "svc", 5);
  reopened.open();
  assert.equal(reopened.cursor, 2);
  assert.equal(reopened.events.length, 2);
  assert.equal(reopened.auto, undefined);
});

test("投递候选只看结构化 mention.execute、晚于基线且从未投递", () => {
  const store = newStore();
  store.commitEvents([
    event(1),
    store_event_pending(),
    mentionEvent(3),
    mentionEvent(4),
    mentionEvent(9),
  ]);
  assert.deepEqual(
    store.pendingAutoEvents(4).map((item) => item.eventId),
    [9],
  );
  assert.equal(store.pendingAutoEvents(0).length, 3);
  assert.equal(store.beginDispatch(9), true);
  assert.deepEqual(store.pendingAutoEvents(0).map((item) => item.eventId), [3, 4], "投递中/已投递不再入列");
});

test("投递状态落盘：sending / delivered / failed，重启后仍在", () => {
  const store = newStore();
  store.commitEvents([mentionEvent(3), mentionEvent(4)]);
  store.beginDispatch(3);
  assert.equal(store.find(3)?.dispatch?.state, "sending");
  store.finishDispatch(3, true);
  store.beginDispatch(4);
  store.finishDispatch(4, false);

  const reopened = new StateStore(store.dir, "svc", 5);
  reopened.open();
  assert.equal(reopened.find(3)?.dispatch?.state, "delivered");
  assert.equal(reopened.find(4)?.dispatch?.state, "failed");
  assert.equal(reopened.dispatchedCount(), 1);
  assert.equal(reopened.unreadCount(), 2, "投递状态不影响未读");
});

test("投递状态写入失败时内存状态不变（不假装已发送）", () => {
  const store = newStore();
  store.commitEvents([mentionEvent(3)]);
  chmodSync(store.dir, 0o500);
  try {
    assert.throws(() => store.beginDispatch(3));
    assert.equal(store.find(3)?.dispatch, undefined);
  } finally {
    chmodSync(store.dir, 0o700);
  }
  assert.equal(store.beginDispatch(3), true);
});

test("绑定：同一 Pi 会话复用，其他会话被拒，不能静默切换 Knot 会话", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-knot-binding-"));
  const stateDir = join(dataDir, "svc", "5");
  mkdirSync(stateDir, { recursive: true });
  const context = { dataDir, stateDir, serviceKey: "svc", agentSessionId: 5, piSessionId: "pi-session-1" };

  checkBinding(context);
  rememberBinding(context);
  checkBinding(context);
  assert.ok(existsSync(bindingPath(stateDir)));

  assert.throws(() => checkBinding({ ...context, piSessionId: "pi-session-2" }), /已绑定 Pi 会话/);

  const otherStateDir = join(dataDir, "svc", "6");
  mkdirSync(otherStateDir, { recursive: true });
  assert.throws(
    () => checkBinding({ ...context, stateDir: otherStateDir, agentSessionId: 6 }),
    /不能静默切换/,
  );
});
