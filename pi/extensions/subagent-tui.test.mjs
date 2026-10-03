#!/usr/bin/env node
/**
 * subagent-tui regression coverage with mocks (no TUI, no network, no SSH).
 *
 * Boots the extension factory with a mock pi API, feeds synthetic
 * `status.json` files under a temporary directory, and renders the widget
 * component through the factory that `ctx.ui.setWidget` receives.
 *
 * Run: node subagent-tui.test.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PI_ROOT = join(
	execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
	"@earendil-works/pi-coding-agent",
);
const { visibleWidth } = await import(
	join(PI_ROOT, "node_modules/@earendil-works/pi-tui/dist/index.js")
);
const { createJiti } = await import(`${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": `${PI_ROOT}/dist/index.js`,
		"@earendil-works/pi-tui": `${PI_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	},
	interopDefault: true,
	moduleCache: false,
});
const factory = await jiti.import(
	join(dirname(fileURLToPath(import.meta.url)), "subagent-tui.ts"),
	{ default: true },
);

const failures = [];
// Functions and undefined are meaningful values here, so serialize them instead
// of letting JSON.stringify collapse them to null/undefined.
const serialized = (value) =>
	JSON.stringify(value, (_key, item) =>
		typeof item === "function" ? "[function]" : item === undefined ? "[undefined]" : item,
	);
function check(name, actual, expected) {
	const a = serialized(actual);
	const e = serialized(expected);
	if (a !== e) failures.push(`${name}: expected ${e}, got ${a}`);
	else console.log(`✓ ${name}`);
}
function checkTrue(name, value, detail = "") {
	if (value) console.log(`✓ ${name}`);
	else failures.push(`${name}${detail ? ` (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST_ROOT = mkdtempSync(join(tmpdir(), "subagent-tui-test-"));
const SESSION_ID = "subagent-tui-test-session";
const runDirs = new Map();
let runSeq = 0;
function writeRun(name, status) {
	const dir = join(TEST_ROOT, `${name}-${(runSeq += 1)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "status.json"), JSON.stringify(status));
	return dir;
}
const step = (agent, model, thinking, extra = {}) => ({
	agent,
	model,
	thinking,
	status: "running",
	startedAt: Date.now() - 4_000,
	lastActivityAt: Date.now(),
	toolCount: 1,
	turnCount: 1,
	...extra,
});
const singleRun = (id, agent, model, thinking, extra = {}) => ({
	runId: id,
	mode: "single",
	state: "running",
	sessionId: SESSION_ID,
	pid: process.pid,
	startedAt: Date.now() - 4_000,
	lastActivityAt: Date.now(),
	currentStep: 0,
	steps: [step(agent, model, thinking)],
	...extra,
});
// A workflow container: no activity of its own, and `steps` are child references.
const workflowRun = (id, childId, agent) => ({
	runId: id,
	mode: "workflow",
	state: "running",
	sessionId: SESSION_ID,
	pid: process.pid,
	startedAt: Date.now() - 120_000,
	currentStep: 0,
	workflowChildren: {
		version: 1,
		workflowRunId: id,
		inventoryComplete: true,
		workflowState: "running",
		children: [{ childId: "child-1", runId: childId, agent, state: "running" }],
	},
	steps: [
		{
			agent,
			async: true,
			runId: childId,
			parentWorkflowRunId: id,
			status: "running",
			startedAt: Date.now() - 120_000,
		},
	],
});

function harness() {
	const handlers = new Map();
	const bus = new Map();
	const widget = { factory: undefined, placement: undefined, installs: 0, removals: 0 };
	const statuses = [];
	const pi = {
		on: (event, handler) => {
			handlers.set(event, handler);
			return () => {};
		},
		events: {
			on: (channel, handler) => {
				bus.set(channel, handler);
				return () => {};
			},
			emit() {},
		},
		registerCommand() {},
		registerFlag() {},
		getFlag: () => false,
	};
	const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget: (_key, content, options) => {
				if (typeof content === "function") {
					widget.factory = content;
					widget.placement = options?.placement;
					widget.installs += 1;
				} else {
					widget.factory = undefined;
					widget.placement = undefined;
					widget.removals += 1;
				}
			},
			setStatus: (_key, text) => statuses.push(text),
			notify() {},
		},
		sessionManager: {
			getSessionFile: () => join(TEST_ROOT, "session.jsonl"),
			getSessionId: () => SESSION_ID,
		},
	};
	factory(pi);
	return { handlers, bus, widget, statuses, ctx, theme };
}
function startSession(h) {
	h.handlers.get("session_start")({ type: "session_start", reason: "startup" }, h.ctx);
}
function shutdownSession(h) {
	h.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, h.ctx);
}
function emit(h, channel, payload) {
	h.bus.get(channel)(payload);
}
const STATUS_LINE = /^[>?!~x+] (?:RUN|WAIT|FAIL|DONE|ATTN|IDLE|STALLED|DEAD) /;
// Rendered rows are wrapped in the panel background padding, so compare trimmed text.
const statusLines = (lines) => lines.map((line) => line.trim()).filter((line) => STATUS_LINE.test(line));
const headerLine = (lines) => lines.map((line) => line.trim()).find((line) => line.startsWith("• subagent tail"));
// Simulate Pi rendering the widget: it calls the factory, which hands the
// component the live TUI object.
function attach(h) {
	const tui = { calls: 0, requestRender() { this.calls += 1; } };
	const component = h.widget.factory(tui, h.theme);
	return { tui, render: (width = 100) => component.render(width) };
}
const startRun = (h, dir) => {
	const id = dir.split("/").pop();
	runDirs.set(id, dir);
	emit(h, "subagent:async-started", { id, asyncDir: dir });
	return id;
};
// pi-subagents writes the terminal state into status.json before announcing it,
// so mirror that ordering: the poll reads the file and must not resurrect the run.
const completeRun = (h, id, state = "complete") => {
	const dir = runDirs.get(id);
	if (dir) {
		const file = join(dir, "status.json");
		writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), state }));
	}
	emit(h, "subagent:async-complete", { id, state });
};

// ── 1. widget lifecycle and active refresh ─────────────────────────────

{
	const h = harness();
	startSession(h);
	check("lifecycle: no widget before any run", h.widget.installs, 0);

	const dir = writeRun("single-a", singleRun("run-a", "worker", "model-a", "high"));
	checkTrue("lifecycle: run id derived from async dir", dir.includes("single-a"));
	const idA = startRun(h, dir);
	check("lifecycle: widget installed for an active run", h.widget.installs, 1);
	check("lifecycle: widget stays above the editor", h.widget.placement, "aboveEditor");

	const view = attach(h);
	checkTrue("lifecycle: factory injects a TUI with requestRender", typeof view.tui.requestRender === "function");
	const afterAttach = view.tui.calls;
	const idB = startRun(h, writeRun("single-b", singleRun("run-b", "scout", "model-b", "low")));
	checkTrue("lifecycle: state change calls the injected requestRender", view.tui.calls > afterAttach, `calls=${view.tui.calls}`);

	const afterChange = view.tui.calls;
	await sleep(260);
	checkTrue("lifecycle: polling refreshes actively instead of relying on setStatus", view.tui.calls > afterChange, `calls=${view.tui.calls}`);
	check("lifecycle: widget is installed only once", h.widget.installs, 1);

	completeRun(h, idA);
	check("lifecycle: widget stays installed while another run is active", [typeof h.widget.factory, h.widget.removals], ["function", 0]);
	completeRun(h, idB);
	check("lifecycle: widget removed when no run is active", [typeof h.widget.factory, h.widget.removals], ["undefined", 1]);
	const afterRemoval = view.tui.calls;
	await sleep(260);
	check("lifecycle: removed widget stops using the old TUI object", view.tui.calls, afterRemoval);
	shutdownSession(h);
	await sleep(150);
	check("lifecycle: shutdown keeps the old TUI object released", view.tui.calls, afterRemoval);
}

// ── 2. session replacement ─────────────────────────────────────────────

{
	const h = harness();
	startSession(h);
	const firstId = startRun(h, writeRun("session-a", singleRun("run-session-a", "worker", "model-a", "high")));
	const first = attach(h);
	first.render();
	startRun(h, writeRun("session-a2", singleRun("run-session-a2", "worker", "model-a2", "high")));
	checkTrue("session: first session uses its own TUI", first.tui.calls > 0, `calls=${first.tui.calls}`);

	shutdownSession(h);
	const afterShutdown = first.tui.calls;
	check("session: shutdown removes the widget", h.widget.factory, undefined);

	startSession(h);
	const secondId = startRun(h, writeRun("session-b", singleRun("run-session-b", "scout", "model-b", "low")));
	const second = attach(h);
	second.render();
	startRun(h, writeRun("session-b2", singleRun("run-session-b2", "scout", "model-b2", "low")));
	checkTrue("session: new session renders through its own TUI", second.tui.calls > 0, `calls=${second.tui.calls}`);

	completeRun(h, firstId);
	completeRun(h, secondId);
	completeRun(h, secondId);
	await sleep(150);
	check("session: old session TUI is not reused after replacement", first.tui.calls, afterShutdown);
	shutdownSession(h);
}

// ── 3. model/thinking live on each subagent row ────────────────────────

{
	const h = harness();
	startSession(h);
	startRun(h, writeRun("row-a", singleRun("run-row-a", "worker", "model-alpha", "high")));
	startRun(h, writeRun("row-b", singleRun("run-row-b", "scout", "model-beta", "low")));
	const view = attach(h);
	const lines = view.render(120);
	const header = headerLine(lines);
	const rows = statusLines(lines);

	check("rows: one status row per active run", rows.length, 2);
	checkTrue("header: keeps the role summary", header.includes(" · role "), header);
	checkTrue("header: no model/thinking aggregation", !header.includes("model-") && !header.toLowerCase().includes("thinking"), header);
	check("header: active count matches visible rows", header.includes("2 active"), true);
	check("footer: subagent count matches visible rows", h.statuses.filter(Boolean).at(-1), "2 subagents");

	const rowA = rows.find((line) => line.includes("worker"));
	const rowB = rows.find((line) => line.includes("scout"));
	checkTrue("rows: worker row shows its own model", rowA.includes("model model-alpha"), rowA);
	checkTrue("rows: worker row shows its own thinking", rowA.includes("thinking high"), rowA);
	checkTrue("rows: scout row shows its own model", rowB.includes("model model-beta"), rowB);
	checkTrue("rows: scout row shows its own thinking", rowB.includes("thinking low"), rowB);
	checkTrue("rows: no cross-contamination between subagents", !rowA.includes("model-beta") && !rowB.includes("model-alpha"), `${rowA} // ${rowB}`);

	const narrow = view.render(40);
	checkTrue("rows: narrow width still renders", narrow.length > 0);
	checkTrue("rows: narrow width truncates every line to the width", narrow.every((line) => visibleWidth(line) <= 40), `max=${Math.max(...narrow.map(visibleWidth))}`);
	checkTrue("rows: narrow width keeps the row identity", statusLines(narrow).length === 2, JSON.stringify(statusLines(narrow)));
	shutdownSession(h);
}

// ── 4. workflow container is not an extra active subagent ──────────────

{
	const h = harness();
	startSession(h);
	const childId = startRun(h, writeRun("workflow-child", singleRun("run-child", "worker", "model-child", "high", { parentWorkflowRunId: "run-workflow" })));
	startRun(h, writeRun("workflow-manager", workflowRun("run-workflow", "run-child", "manager")));
	const view = attach(h);
	const lines = view.render(120);
	const rows = statusLines(lines);

	check("workflow: a container plus its linked single counts as one active subagent", rows.length, 1);
	checkTrue("workflow: the visible row is the real child", rows[0].includes("worker"), rows[0]);
	checkTrue("workflow: the manager row is not rendered", rows.every((row) => !row.includes("manager")), JSON.stringify(rows));
	checkTrue("workflow: no fake stalled/dead warning for the container", lines.every((line) => !/STALLED|DEAD/.test(line)), JSON.stringify(lines));
	check("workflow: header active count matches", headerLine(lines).includes("1 active"), true);
	check("workflow: footer count matches", h.statuses.filter(Boolean).at(-1), "1 subagent");

	// Only the collapsed child remains; completing it clears the panel.
	completeRun(h, childId);
	await sleep(150);
	check("workflow: completing the child removes the widget", typeof h.widget.factory, "undefined");
	shutdownSession(h);
}

// ── 5. real parallel subagents are preserved ───────────────────────────

{
	const h = harness();
	startSession(h);
	startRun(h, writeRun("parallel-a", singleRun("run-p1", "worker", "shared-model", "high")));
	startRun(h, writeRun("parallel-b", singleRun("run-p2", "worker", "shared-model", "high")));	const view = attach(h);
	const rows = statusLines(view.render(120));
	check("parallel: two real subagents with the same role and model stay separate", rows.length, 2);
	check("parallel: header matches", headerLine(view.render(120)).includes("2 active"), true);
	shutdownSession(h);
}

{
	const h = harness();
	startSession(h);
	const loneId = startRun(h, writeRun("standalone", singleRun("run-alone", "worker", "model-alone", "medium")));
	const view = attach(h);
	const lines = view.render(120);
	check("single: standalone subagent without parent info stays visible", statusLines(lines).length, 1);
	checkTrue("single: its own model is shown", lines.some((line) => line.includes("model model-alone")), JSON.stringify(lines));
	check("single: header matches", headerLine(lines).includes("1 active"), true);

	completeRun(h, loneId);
	await sleep(150);
	check("single: terminal record is not counted active", [statusLines(view.render(120)).length, typeof h.widget.factory], [0, "undefined"]);
	shutdownSession(h);
}

// ── 6. real stall and attention warnings survive ───────────────────────

{
	const h = harness();
	startSession(h);
	const stale = Date.now() - 120_000;
	startRun(
		h,
		writeRun(
			"stalled",
			singleRun("run-stalled", "worker", "model-s", "high", {
				startedAt: stale,
				lastActivityAt: stale,
				steps: [step("worker", "model-s", "high", { startedAt: stale, lastActivityAt: stale })],
			}),
		),
	);
	startRun(
		h,
		writeRun("attention", singleRun("run-attention", "scout", "model-r", "low", { activityState: "needs_attention" })),
	);
	const rows = statusLines(attach(h).render(120));
	check("warnings: a genuinely stalled subagent still reports STALLED", rows.some((row) => row.includes("STALLED")), true);
	check("warnings: an attention state still reports ATTN", rows.some((row) => row.startsWith("! ATTN")), true);
	check("warnings: both real subagents stay visible", rows.length, 2);
	shutdownSession(h);
}

console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
process.exitCode = failures.length === 0 ? 0 : 1;
