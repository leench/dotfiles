import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Native pi-subagents TUI replacement notes (2026-08-26):
 *
 * The native asyncWidget/FleetView is disabled in
 * extensions/subagent/config.json. This panel intentionally does not yet
 * reproduce every native field. Revisit these gaps before extending it:
 *
 * - fresh/fork context badges;
 * - exact parallel/chain aggregation (running/done counts and parallel groups);
 * - nested child-run hierarchy and overflow summaries;
 * - native output-N.log/artifact path hints;
 * - current-tool elapsed time and native activity wording;
 * - FleetView window-vs-spent token metrics;
 * - external jobs and Herdr project-pane entries;
 * - FleetView keyboard navigation and inspector actions.
 *
 * The custom panel already adds session token totals, current path/tool
 * details, recent output, and stalled/dead-process detection.
 */

const WIDGET_ID = "subagent-live-tail";
const STATUS_ID = "subagent-live-tail-status";
const POLL_INTERVAL_MS = 200;
const FOREGROUND_REFRESH_INTERVAL_MS = 1_000;
const DISCOVERY_INTERVAL_MS = 10_000;
const DISCOVERY_CACHE_LIMIT = 512;
const DISCOVERY_RETRY_BASE_MS = 5_000;
const DISCOVERY_RETRY_MAX_MS = 60_000;
const MIN_TAIL_LINES = 1;
const DEFAULT_TAIL_LINES = 3;
const MAX_TAIL_LINES = 32;
const OUTPUT_LINES_PER_UPDATE = 5;
const TOP_GAP_LINES = 1;
const BOTTOM_GAP_LINES = 1;
const STALL_WARNING_MS = 10_000;
const STALL_CRITICAL_MS = 30_000;
const MAX_LOG_ENTRIES = 240;
const TERMINAL_RETENTION_MS = 10_000;
const MAX_TRACKED_RUNS = 32;
const MAX_SCAN_RUNS = 100;
const ASYNC_STARTED_EVENT = "subagent:async-started";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

type LogLevel = "info" | "success" | "error" | "dim";

type LogEntry = {
	text: string;
	level: LogLevel;
};

type DetailLine =
	| {
			kind: "status";
			prefix: string;
			marker: string;
			label: string;
			suffix: string;
	  }
	| { kind: "text"; text: string };

type TokenUsage = {
	input: number;
	output: number;
	total: number;
};

type SessionTokenSnapshot = {
	startedAt: number;
	offset: number;
	remainder: string;
	usage: TokenUsage;
};

type StepSnapshot = {
	tool?: string;
	output: string[];
	latest?: AsyncStep;
	sessionUsage?: TokenUsage;
};

type AsyncStep = {
	agent?: unknown;
	label?: unknown;
	description?: unknown;
	task?: unknown;
	phase?: unknown;
	model?: unknown;
	thinking?: unknown;
	status?: unknown;
	activityState?: unknown;
	startedAt?: unknown;
	currentTool?: unknown;
	currentToolArgs?: unknown;
	currentToolStartedAt?: unknown;
	currentPath?: unknown;
	recentOutput?: unknown;
	recentTools?: unknown;
	lastActivityAt?: unknown;
	toolCount?: unknown;
	turnCount?: unknown;
	sessionFile?: unknown;
	tokens?: unknown;
	totalTokens?: unknown;
	usage?: unknown;
};

type AsyncStatus = {
	runId?: unknown;
	state?: unknown;
	mode?: unknown;
	agent?: unknown;
	agents?: unknown;
	model?: unknown;
	thinking?: unknown;
	activityState?: unknown;
	startedAt?: unknown;
	lastActivityAt?: unknown;
	lastUpdate?: unknown;
	deadlineAt?: unknown;
	pid?: unknown;
	currentStep?: unknown;
	currentTool?: unknown;
	currentToolArgs?: unknown;
	currentToolStartedAt?: unknown;
	currentPath?: unknown;
	recentOutput?: unknown;
	recentTools?: unknown;
	toolCount?: unknown;
	turnCount?: unknown;
	sessionFile?: unknown;
	totalTokens?: unknown;
	tokens?: unknown;
	usage?: unknown;
	n?: unknown;
	steps?: unknown;
	/** Workflow containers only: child run inventory (`children`, `workflowRunId`, ...). */
	workflowChildren?: unknown;
};

type TrackedRun = {
	id: string;
	label: string;
	model?: string;
	asyncDir?: string;
	foreground: boolean;
	state: string;
	startedAt: number;
	finishedAt?: number;
	terminalLogged: boolean;
	status?: AsyncStatus;
	statusFingerprint?: string;
	pidAlive?: boolean;
	sessionUsage?: TokenUsage;
	sessionUsageCheckedAt?: number;
	stepSnapshots: Map<string, StepSnapshot>;
	sessionTokenSnapshots: Map<string, SessionTokenSnapshot>;
};

type DiscoverySnapshot = {
	mtimeMs?: number;
	size?: number;
	status?: AsyncStatus;
	failures: number;
	retryAt: number;
};

type ThemeColor =
	| "accent"
	| "muted"
	| "success"
	| "error"
	| "dim"
	| "text"
	| "warning"
	| "syntaxFunction"
	| "syntaxType"
	| "syntaxString"
	| "syntaxNumber"
	| "mdLink"
	| "toolTitle"
	| "customMessageLabel"
	| "syntaxVariable"
	| "syntaxKeyword"
	| "mdHeading"
	| "thinkingLow"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax";

type ThemeBackground =
	| "selectedBg"
	| "searchMatchBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
	bg: (color: ThemeBackground, text: string) => string;
};

// Keep role colors separate from the header's `accent` color.
const ROLE_COLORS: ThemeColor[] = [
	"syntaxString",
	"customMessageLabel",
	"mdLink",
	"success",
	"error",
	"warning",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxVariable",
	"syntaxType",
	"thinkingMax",
	"mdHeading",
	"thinkingXhigh",
	"thinkingLow",
	"syntaxKeyword",
];

const ROLE_COLOR_BY_NAME: Record<string, ThemeColor> = {
	reviewer: "syntaxString",
	planner: "customMessageLabel",
	worker: "mdLink",
	scout: "text",
	vision: "error",
	researcher: "warning",
	advisor: "syntaxFunction",
	"context-builder": "syntaxNumber",
	delegate: "syntaxVariable",
	oracle: "syntaxType",
	"reviewer-adv": "thinkingMax",
};

type AsyncReference = {
	id: string;
	asyncDir: string;
	agent?: unknown;
};

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stripAnsi(value: string): string {
	const escape = String.fromCharCode(0x1b);
	let clean = "";
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== escape || value[index + 1] !== "[") {
			clean += value[index];
			continue;
		}
		index += 2;
		for (; index < value.length; index += 1) {
			const code = value.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) break;
		}
	}
	return clean;
}

function sanitizeLine(value: unknown): string {
	const source = stripAnsi(String(value ?? ""));
	let clean = "";
	for (const character of source) {
		const code = character.charCodeAt(0);
		if (code === 10 || code === 13) clean += "\n";
		else if (code === 9 || code < 32 || code === 127) clean += " ";
		else clean += character;
	}
	return clean.replace(/\s+$/g, "").trim();
}

function shortenPath(value: string): string {
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function preview(value: unknown, maxLength = 100): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return "";
	const clean = sanitizeLine(text);
	return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

function formatTool(
	tool: unknown,
	args?: unknown,
	currentPath?: unknown,
): string {
	const toolName = asString(tool);
	if (!toolName) return "working";
	const pathValue = asString(currentPath);
	if (pathValue) {
		const argsText = preview(args, 64);
		return argsText
			? `${toolName} ${shortenPath(pathValue)} · ${argsText}`
			: `${toolName} ${shortenPath(pathValue)}`;
	}
	const argsText = preview(args, 90);
	return argsText ? `${toolName} ${argsText}` : toolName;
}

function formatAgent(value: unknown, fallback: string): string {
	if (typeof value === "string" && value) return value;
	if (Array.isArray(value)) {
		const agents = value.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
		if (agents.length) return agents.join("+");
	}
	return fallback;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function tokenUsage(value: unknown): TokenUsage | undefined {
	const data = asObject(value);
	if (!data) return undefined;
	const input = asFiniteNumber(
		data.input ?? data.inputTokens ?? data.prompt ?? data.promptTokens,
	);
	const output = asFiniteNumber(
		data.output ?? data.outputTokens ?? data.completion ?? data.completionTokens,
	);
	const total = asFiniteNumber(data.total ?? data.totalTokens);
	if (input === undefined && output === undefined && total === undefined)
		return undefined;
	return {
		input: input ?? 0,
		output: output ?? 0,
		total: total ?? (input ?? 0) + (output ?? 0),
	};
}

function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		total: left.total + right.total,
	};
}

function formatTokenCount(value: number): string {
	const count = Math.max(0, Math.round(value));
	if (count >= 1_000_000)
		return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}m`;
	if (count >= 1_000)
		return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
	return String(count);
}

function formatTokenUsage(usage: TokenUsage): string {
	return `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)}`;
}

function safeSessionFile(value: unknown): string | undefined {
	const raw = asString(value);
	if (!raw) return undefined;
	const resolved = path.resolve(raw);
	const sessionsRoot = path.resolve(os.homedir(), ".pi", "agent", "sessions");
	return resolved === sessionsRoot || resolved.startsWith(`${sessionsRoot}${path.sep}`)
		? resolved
		: undefined;
}

function sessionLineUsage(line: string, startedAt: number): TokenUsage | undefined {
	try {
		const data = asObject(JSON.parse(line));
		if (!data) return undefined;
		const message = asObject(data.message);
		const timestamp = asString(data.timestamp) ?? asString(message?.timestamp);
		if (timestamp) {
			const timestampMs = Date.parse(timestamp);
			if (Number.isFinite(timestampMs) && timestampMs < startedAt) return undefined;
		}
		return tokenUsage(data.usage ?? message?.usage);
	} catch {
		return undefined;
	}
}

function readSessionUsage(
	run: TrackedRun,
	fileValue: unknown,
	startedAt: number,
): TokenUsage | undefined {
	const sessionFile = safeSessionFile(fileValue);
	if (!sessionFile) return undefined;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(sessionFile);
	} catch {
		return undefined;
	}
	let snapshot = run.sessionTokenSnapshots.get(sessionFile);
	if (!snapshot || snapshot.startedAt !== startedAt || stat.size < snapshot.offset) {
		snapshot = {
			startedAt,
			offset: 0,
			remainder: "",
			usage: { input: 0, output: 0, total: 0 },
		};
	}
	if (stat.size > snapshot.offset) {
		let fileDescriptor: number | undefined;
		try {
			const length = stat.size - snapshot.offset;
			const buffer = Buffer.allocUnsafe(length);
			fileDescriptor = fs.openSync(sessionFile, "r");
			fs.readSync(fileDescriptor, buffer, 0, length, snapshot.offset);
			const lines = `${snapshot.remainder}${buffer.toString("utf8")}`.split("\n");
			snapshot.remainder = lines.pop() ?? "";
			for (const line of lines) {
				const usage = sessionLineUsage(line, startedAt);
				if (usage) snapshot.usage = addTokenUsage(snapshot.usage, usage);
			}
			snapshot.offset = stat.size;
		} catch {
			// Session files are append-only and best-effort; retry on the next poll.
		} finally {
			if (fileDescriptor !== undefined) {
				try {
					fs.closeSync(fileDescriptor);
				} catch {
					// Best effort.
				}
			}
		}
	}
	run.sessionTokenSnapshots.set(sessionFile, snapshot);
	return snapshot.usage.total > 0 ? snapshot.usage : undefined;
}

function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3_600);
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

function statusSteps(status: AsyncStatus | undefined): AsyncStep[] {
	const data = asObject(status);
	return asArray(data?.steps)
		.map((step) => asObject(step) as AsyncStep | undefined)
		.filter((step): step is AsyncStep => Boolean(step));
}

function observedSteps(run: TrackedRun, status: AsyncStatus | undefined): AsyncStep[] {
	const persisted = statusSteps(status);
	if (persisted.length > 0) return persisted;
	return [...run.stepSnapshots.values()]
		.map((snapshot) => snapshot.latest)
		.filter((step): step is AsyncStep => Boolean(step));
}

function runIdentity(
	run: TrackedRun,
	status: AsyncStatus | undefined,
): { roles: string[] } {
	const data = asObject(status);
	const steps = observedSteps(run, status);
	const runningSteps = steps.filter(
		(step) => ["pending", "queued", "running"].includes(asString(step.status) ?? "running"),
	);
	const identitySteps = runningSteps.length > 0 ? runningSteps : steps.slice(-1);
	const roles = [
		...new Set(
			identitySteps.map((step) =>
				formatAgent(step.agent ?? step.label, run.label),
			),
		),
	];
	if (roles.length === 0)
		roles.push(formatAgent(data?.agent ?? data?.agents, run.label));
	return { roles };
}

function latestActivityAt(
	run: TrackedRun,
	status: AsyncStatus | undefined,
	steps: AsyncStep[],
): number {
	const data = asObject(status);
	const timestamps = [
		...steps.flatMap((step) => [
			asFiniteNumber(step.lastActivityAt),
			asFiniteNumber(step.currentToolStartedAt),
		]),
		asFiniteNumber(data?.lastActivityAt),
		asFiniteNumber(data?.currentToolStartedAt),
		asFiniteNumber(data?.lastUpdate),
		asFiniteNumber(data?.startedAt),
	].filter((value): value is number => value !== undefined);
	return timestamps.length > 0 ? Math.max(...timestamps) : run.startedAt;
}

function processAlive(value: unknown): boolean | undefined {
	const pid = asFiniteNumber(value);
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return asObject(error)?.code === "EPERM";
	}
}

function latestOutput(
	status: AsyncStatus | undefined,
	steps: AsyncStep[],
): string | undefined {
	const data = asObject(status);
	const sources = [
		data?.recentOutput,
		...steps.map((step) => step.recentOutput),
	];
	for (
		let sourceIndex = sources.length - 1;
		sourceIndex >= 0;
		sourceIndex -= 1
	) {
		const lines = asArray(sources[sourceIndex]).map(sanitizeLine).filter(Boolean);
		if (lines.length > 0) return preview(lines.at(-1), 96);
	}
	return undefined;
}

function runDetailLines(
	run: TrackedRun,
	status: AsyncStatus | undefined,
	now: number,
): DetailLine[] {
	const data = asObject(status);
	const observed = observedSteps(run, status);
	const candidates = observed.map((step, index) => ({ step, index }));
	const activeCandidates = candidates.filter(({ step }) => {
		const state = asString(step.status);
		return (
			state === undefined ||
			state === "pending" ||
			state === "queued" ||
			state === "running"
		);
	});
	const displayCandidates: Array<{ step?: AsyncStep; index: number }> =
		activeCandidates.length > 0 ? activeCandidates : candidates.slice(-1);
	if (displayCandidates.length === 0) displayCandidates.push({ index: -1 });

	const currentIndex = asFiniteNumber(data?.currentStep);
	const runStartedAt = asFiniteNumber(data?.startedAt) ?? run.startedAt;
	const mode = asString(data?.mode);
	const lines: DetailLine[] = [];

	for (const candidate of displayCandidates) {
		const step = candidate.step;
		const isCurrent =
			candidate.index === currentIndex ||
			(currentIndex === undefined && displayCandidates.length === 1);
		const state =
			asString(step?.status) ??
			(isCurrent ? asString(data?.state) : undefined) ??
			run.state;
		const normalizedState = state.toLowerCase();
		const canStall = normalizedState === "running" || normalizedState === "working";
		const activityState =
			asString(step?.activityState) ??
			(isCurrent ? asString(data?.activityState) : undefined);
		const startedAt =
			asFiniteNumber(step?.startedAt) ??
			(isCurrent ? runStartedAt : undefined) ??
			runStartedAt;
		const lastActivity =
			asFiniteNumber(step?.lastActivityAt) ??
			asFiniteNumber(step?.currentToolStartedAt) ??
			(canStall ? latestActivityAt(run, status, step ? [step] : []) : run.startedAt);
		const idleFor = Math.max(0, now - lastActivity);
		let prefix = ">";
		let marker = "RUN";
		if (normalizedState === "pending" || normalizedState === "queued") {
			prefix = "?";
			marker = "WAIT";
		} else if (["failed", "rejected", "stopped"].includes(normalizedState)) {
			prefix = "x";
			marker = "FAIL";
		} else if (["complete", "completed"].includes(normalizedState)) {
			prefix = "+";
			marker = "DONE";
		} else if (activityState?.includes("blocked") || activityState?.includes("attention")) {
			prefix = "!";
			marker = "ATTN";
		} else if (canStall && idleFor >= STALL_CRITICAL_MS) {
			prefix = run.pidAlive === false ? "x" : "!";
			marker = run.pidAlive === false ? "DEAD" : "STALLED";
		} else if (canStall && idleFor >= STALL_WARNING_MS) {
			prefix = "~";
			marker = "IDLE";
		}

		const label = formatAgent(
			step?.agent ?? step?.label ?? (isCurrent ? data?.agent ?? data?.agents : undefined),
			run.label,
		);
		// Each row reports its own model and thinking level as `provider/model:level`.
		const model =
			asString(step?.model) ??
			(isCurrent ? run.model ?? asString(data?.model) : undefined);
		const thinking =
			asString(step?.thinking) ??
			(isCurrent ? asString(data?.thinking) : undefined);
		const modelLabel = model
			? thinking && !model.endsWith(`:${thinking}`)
				? `${model}:${thinking}`
				: model
			: undefined;
		const parts = [
			run.foreground ? "sync" : "async",
			...(modelLabel ? [modelLabel] : []),
			`up ${formatDuration(now - startedAt)}`,
			`last ${formatDuration(idleFor)} ago`,
		];
		if (observed.length > 1 && candidate.index >= 0)
			parts.push(`step ${candidate.index + 1}/${observed.length}`);
		if (activityState && activityState !== state) parts.push(activityState);
		if (mode && observed.length <= 1) parts.push(mode);
		const toolCount = asFiniteNumber(step?.toolCount ?? (isCurrent ? data?.toolCount : undefined));
		if (toolCount !== undefined) parts.push(`tools ${toolCount}`);
		const turnCount = asFiniteNumber(step?.turnCount ?? (isCurrent ? data?.turnCount : undefined));
		if (turnCount !== undefined) parts.push(`turns ${turnCount}`);
		const stepSnapshot = run.stepSnapshots.get(`step:${candidate.index}`);
		const usage =
			tokenUsage(step?.tokens ?? step?.totalTokens ?? step?.usage) ??
			(isCurrent
				? tokenUsage(data?.totalTokens ?? data?.tokens ?? data?.usage ?? data?.n)
				: undefined) ??
			stepSnapshot?.sessionUsage ??
			(isCurrent ? run.sessionUsage : undefined);
		if (usage) parts.push(formatTokenUsage(usage));
		const elapsedMs = now - startedAt;
		if (usage && usage.output > 0 && elapsedMs >= 1_000)
			parts.push(`${Math.round(usage.output / (elapsedMs / 1000))} tok/s`);
		lines.push({
			kind: "status",
			prefix,
			marker,
			label,
			suffix: parts.join(" · "),
		});

		const description = asString(step?.description) ?? asString(step?.task);
		if (description)
			lines.push({ kind: "text", text: `  task: ${preview(description, 140)}` });
		const tool = step?.currentTool ?? (isCurrent ? data?.currentTool : undefined);
		const args = step?.currentToolArgs ?? (isCurrent ? data?.currentToolArgs : undefined);
		const currentPath = step?.currentPath ?? (isCurrent ? data?.currentPath : undefined);
		const activity = formatTool(tool, args, currentPath);
		if (activity !== "working")
			lines.push({ kind: "text", text: `  tool: ${activity}` });
		else {
			const recent = asArray(step?.recentTools)
				.map(asObject)
				.filter((value): value is Record<string, unknown> => Boolean(value))
				.at(-1);
			const recentTool = recent
				? formatTool(recent.tool, recent.args, recent.path)
				: undefined;
			if (recentTool && recentTool !== "working")
				lines.push({ kind: "text", text: `  recent: ${recentTool}` });
		}
		const output = step ? latestOutput(undefined, [step]) : latestOutput(status, []);
		if (output) lines.push({ kind: "text", text: `  output: ${output}` });
		if (canStall && idleFor >= STALL_WARNING_MS) {
			const processHint = run.pidAlive === false ? "; process not found" : "";
			lines.push({
				kind: "text",
				text: `  no child progress for ${formatDuration(idleFor)}${processHint}`,
			});
		}
	}
	return lines;
}

function nowLabel(): string {
	return new Date().toLocaleTimeString([], { hour12: false });
}

function terminalState(state: string): boolean {
	return (
		state === "complete" ||
		state === "completed" ||
		state === "failed" ||
		state === "stopped" ||
		state === "paused" ||
		state === "rejected"
	);
}

// A workflow record is a container, not an executing agent: its `steps` are
// child run references (`async: true` with the child `runId`, whose own status
// names this run as `parentWorkflowRunId`), so it must not be counted as a
// subagent or reported as stalled for having no progress of its own.
function isWorkflowRecord(status: AsyncStatus | undefined): boolean {
	const data = asObject(status);
	return (
		asString(data?.mode) === "workflow" ||
		asObject(data?.workflowChildren) !== undefined
	);
}

function safeAsyncDir(value: unknown): string | undefined {
	const raw = asString(value);
	if (!raw) return undefined;
	const resolved = path.resolve(raw);
	const tempRoot = path.resolve(os.tmpdir());
	if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`))
		return undefined;
	return resolved;
}

function extractAsyncReference(value: unknown): AsyncReference | undefined {
	const object = asObject(value);
	const details = asObject(object?.details) ?? object;
	const asyncDir = safeAsyncDir(details?.asyncDir);
	if (!asyncDir) return undefined;
	const id =
		asString(details?.asyncId) ??
		asString(details?.runId) ??
		asString(details?.id) ??
		path.basename(asyncDir);
	return {
		id,
		asyncDir,
		agent: details?.agent ?? details?.agents,
	};
}

function readJson(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

function readStatus(asyncDir: string): AsyncStatus | undefined {
	const value = readJson(path.join(asyncDir, "status.json"));
	return asObject(value) as AsyncStatus | undefined;
}

export default function subagentLiveTail(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	// Injected by the widget factory; cleared when the widget is removed so a
	// replaced session can never be rendered through a stale TUI object.
	let widgetTui: TUI | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetInstalled = false;
	let lastRenderAt = 0;
	let lastStatusText: string | undefined;
	let visible = true;
	let paused = false;
	let tailLines = DEFAULT_TAIL_LINES;
	let logs: LogEntry[] = [];
	const runs = new Map<string, TrackedRun>();
	const discoveryCache = new Map<string, DiscoverySnapshot>();

	function requestRender(): void {
		try {
			if (!widgetTui) return;
			widgetTui.requestRender();
			lastRenderAt = Date.now();
		} catch {
			// A replaced session can invalidate the TUI; the next widget install repairs it.
		}
	}

	function appendLog(text: unknown, level: LogLevel = "info"): void {
		const source = sanitizeLine(text);
		if (!source) return;
		for (const rawLine of source.split("\n")) {
			const line = sanitizeLine(rawLine);
			if (!line) continue;
			logs.push({ text: `${nowLabel()} ${line}`, level });
		}
		if (logs.length > MAX_LOG_ENTRIES)
			logs.splice(0, logs.length - MAX_LOG_ENTRIES);
	}

	function activeRuns(): TrackedRun[] {
		return [...runs.values()].filter(
			(run) => !terminalState(run.state) && !isWorkflowRecord(run.status),
		);
	}

	function activeChildCount(active: TrackedRun[]): number {
		return active.reduce((count, run) => {
			const steps = observedSteps(run, run.status);
			const runningSteps = steps.filter((step) => {
				const state = asString(step.status);
				return (
					state === undefined ||
					state === "pending" ||
					state === "queued" ||
					state === "running"
				);
			});
			return count + Math.max(1, runningSteps.length);
		}, 0);
	}

	function updateStatus(): void {
		if (!currentCtx?.hasUI || currentCtx.mode !== "tui") return;
		const active = activeRuns();
		const childCount = activeChildCount(active);
		let text: string | undefined;
		if (childCount > 0) {
			let suffix = "";
			if (paused) suffix = " paused";
			else if (!visible) suffix = " off";
			const plural = childCount === 1 ? "" : "s";
			text = `${childCount} subagent${plural}${suffix}`;
		}
		if (text === lastStatusText) return;
		lastStatusText = text;
		currentCtx.ui.setStatus(STATUS_ID, text);
	}

	function renderPanel(width: number, theme: ThemeLike): string[] {
		if (!visible) return [];
		const active = activeRuns();
		if (active.length === 0 && logs.length === 0) return [];

		const activeStatuses = active.map((run) => ({
			run,
			status: run.status,
		}));
		const activeChildTotal = activeChildCount(active);
		const roles = [
			...new Set(
				activeStatuses.flatMap(({ run, status }) => runIdentity(run, status).roles),
			),
		];
		const roleColors = new Map<string, ThemeColor>();
		for (const [index, role] of roles.entries())
			roleColors.set(
				role,
				ROLE_COLOR_BY_NAME[role] ?? ROLE_COLORS[index % ROLE_COLORS.length],
			);
		const lines: string[] = [];
		const activeLabel = active.length > 0
			? `${activeChildTotal} active${active.length !== activeChildTotal ? ` · ${active.length} ${active.length === 1 ? "run" : "runs"}` : ""}`
			: "idle";
		const headerPrefix = `• subagent tail · ${activeLabel} · poll ${POLL_INTERVAL_MS}ms`;
		const headerIdentity =
			active.length > 0
				? theme.fg("accent", " · role ") +
					(roles.length > 0
						? roles
							.map((role) =>
								theme.fg(roleColors.get(role) ?? "accent", role),
							)
							.join(theme.fg("accent", "+"))
						: theme.fg("accent", "unknown"))
				: "";
		lines.push(
			theme.fg("accent", `${headerPrefix}${paused ? " · paused" : ""}`) +
				headerIdentity,
		);

		const markerColors: Record<string, ThemeColor> = {
			">": "success",
			"?": "accent",
			"!": "accent",
			"~": "accent",
			x: "error",
			"+": "success",
		};
		const now = Date.now();
		for (const { run, status } of activeStatuses) {
			for (const detail of runDetailLines(run, status, now)) {
				if (detail.kind === "status") {
					const markerColor = markerColors[detail.prefix] ?? "muted";
					let roleColor = roleColors.get(detail.label);
					if (!roleColor) {
						roleColor =
							ROLE_COLOR_BY_NAME[detail.label] ??
							ROLE_COLORS[roleColors.size % ROLE_COLORS.length];
						roleColors.set(detail.label, roleColor);
					}
					const asyncLabel = detail.suffix.startsWith("async · ") ? "async" : undefined;
					const syncLabel = detail.suffix.startsWith("sync · ") ? "sync" : undefined;
					const modePrefix = asyncLabel ? "async · " : syncLabel ? "sync · " : "";
					const modelLabel = modePrefix
						? detail.suffix.slice(modePrefix.length).split(" · ", 1)[0]
						: undefined;
					const renderedSuffix = detail.suffix
						.replace(/^(?:async|sync) · /, "")
						.replace(modelLabel ? `${modelLabel} · ` : "\u0000", "");
					lines.push(
						theme.fg(markerColor, `${detail.prefix} ${detail.marker}`) +
							theme.fg(roleColor, ` ${detail.label}`) +
							theme.fg("muted", " · ") +
							(asyncLabel ? theme.fg("warning", asyncLabel) + theme.fg("muted", " · ") : "") +
							(modelLabel ? theme.fg("text", modelLabel) + theme.fg("muted", " · ") : "") +
							theme.fg("muted", renderedSuffix),
					);
				} else lines.push(theme.fg("muted", detail.text));
			}
		}

		const tail = logs.slice(-tailLines);
		for (const entry of tail) {
			let color: ThemeColor = "text";
			switch (entry.level) {
				case "success":
					color = "success";
					break;
				case "error":
					color = "error";
					break;
				case "dim":
					color = "dim";
					break;
				default:
					break;
			}
			lines.push(theme.fg(color, `  • ${entry.text}`));
		}

		const contentWidth = Math.max(1, width - 2);
		const blockBackground = (text: string): string =>
			theme.bg("toolPendingBg", text);
		const blockLines = lines.map((line) => {
			const content = truncateToWidth(line, contentWidth, "");
			const padding = Math.max(0, contentWidth - visibleWidth(content));
			return blockBackground(` ${content}${" ".repeat(padding)} `);
		});
		const blockBlankLine = blockBackground(" ".repeat(contentWidth + 2));
		return [
			...Array.from({ length: TOP_GAP_LINES }, () => ""),
			blockBlankLine,
			...blockLines,
			blockBlankLine,
			...Array.from({ length: BOTTOM_GAP_LINES }, () => ""),
		];
	}

	function installWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI || ctx.mode !== "tui" || !visible || activeRuns().length === 0)
			return;
		if (!widgetInstalled) {
			ctx.ui.setWidget(
				WIDGET_ID,
				(tui, theme) => {
					widgetTui = tui;
					return {
						render: (width: number) => renderPanel(width, theme),
						invalidate: () => undefined,
					};
				},
				{ placement: "aboveEditor" },
			);
			widgetInstalled = true;
		}
		updateStatus();
	}

	function removeWidget(ctx: ExtensionContext): void {
		widgetTui = undefined;
		if (!widgetInstalled) return;
		ctx.ui.setWidget(WIDGET_ID, undefined);
		widgetInstalled = false;
	}

	function refreshUi(): void {
		if (!currentCtx?.hasUI || currentCtx.mode !== "tui") return;
		const active = activeRuns();
		if (visible && active.length > 0) installWidget(currentCtx);
		else {
			removeWidget(currentCtx);
			if (active.length === 0) logs = [];
		}
		updateStatus();
		requestRender();
	}

	function rememberRun(run: TrackedRun): void {
		runs.set(run.id, run);
		if (runs.size <= MAX_TRACKED_RUNS) return;
		const removable = [...runs.values()]
			.filter((candidate) => terminalState(candidate.state))
			.sort(
				(left, right) =>
					(left.finishedAt ?? left.startedAt) -
					(right.finishedAt ?? right.startedAt),
			);
		for (const candidate of removable.slice(
			0,
			Math.max(0, runs.size - MAX_TRACKED_RUNS),
		))
			runs.delete(candidate.id);
	}

	function trackAsyncStarted(payload: unknown, source: "event" | "scan"): void {
		const data = asObject(payload);
		const id = asString(data?.id) ?? asString(data?.runId);
		const asyncDir = safeAsyncDir(data?.asyncDir);
		if (!id || !asyncDir) return;
		const existing = runs.get(id);
		if (existing) {
			existing.asyncDir = asyncDir;
			if (existing.state === "paused") {
				existing.state = "running";
				existing.finishedAt = undefined;
				existing.terminalLogged = false;
			}
			return;
		}
		const agent = formatAgent(data?.agent ?? data?.agents, "subagent");
		const run: TrackedRun = {
			id,
			label: agent,
			asyncDir,
			foreground: false,
			state: "running",
			startedAt: Date.now(),
			terminalLogged: false,
			stepSnapshots: new Map(),
			sessionTokenSnapshots: new Map(),
		};
		rememberRun(run);
		appendLog(
			`${source === "scan" ? "attached" : "started"} ${agent} [${id}]`,
			"info",
		);
	}

	function trackAsyncComplete(payload: unknown): void {
		const data = asObject(payload);
		const id = asString(data?.id) ?? asString(data?.runId);
		if (!id) return;
		const run = runs.get(id);
		if (!run) return;
		run.finishedAt = Date.now();
		const state = asString(data?.state) ?? asString(data?.status) ?? "complete";
		run.state = state;
		run.status = { ...(asObject(run.status) ?? {}), state } as AsyncStatus;
		run.statusFingerprint = statusFingerprint(run.status);
		if (run.asyncDir && currentCtx?.hasUI && currentCtx.mode === "tui")
			cacheDiscoveryStatus(run.asyncDir, run.status);
		if (!run.terminalLogged) {
			appendLog(
				`${state} ${run.label} [${id}]`,
				state === "complete" || state === "completed" ? "success" : "error",
			);
			run.terminalLogged = true;
		}
		refreshUi();
		schedulePoll();
	}

	function appendNewOutput(
		run: TrackedRun,
		key: string,
		value: unknown,
		label = run.label,
	): void {
		const lines = asArray(value).map(sanitizeLine).filter(Boolean);
		if (lines.length === 0) return;
		const previous = run.stepSnapshots.get(key) ?? { output: [] };
		let start = Math.max(0, lines.length - OUTPUT_LINES_PER_UPDATE);
		const previousLast = previous.output.at(-1);
		if (previousLast) {
			const index = lines.lastIndexOf(previousLast);
			if (index >= 0) start = index + 1;
		}
		for (const line of lines.slice(start))
			appendLog(`${label}: ${line}`, "dim");
		previous.output = lines.slice(-50);
		run.stepSnapshots.set(key, previous);
	}

	function updateStep(run: TrackedRun, step: AsyncStep, index: number): void {
		if (run.label === "foreground subagent" && step.agent !== undefined)
			run.label = formatAgent(step.agent, run.label);
		const model = asString(step.model);
		if (model) run.model = model;
		const key = `step:${index}`;
		const previous = run.stepSnapshots.get(key) ?? { output: [] };
		const currentTool = asString(step.currentTool);
		const label = formatAgent(step.agent ?? step.label, run.label);
		const toolActivity = currentTool
			? formatTool(currentTool, step.currentToolArgs, step.currentPath)
			: undefined;
		if (toolActivity && toolActivity !== previous.tool) {
			appendLog(
				`${label} -> ${toolActivity}`,
				"info",
			);
		}
		if (!toolActivity && previous.tool)
			appendLog(`${label} <- tool finished`, "dim");
		previous.tool = toolActivity;
		previous.latest = step;
		run.stepSnapshots.set(key, previous);
		appendNewOutput(run, key, step.recentOutput, label);
	}

	function updateAsyncRun(run: TrackedRun, status: AsyncStatus): boolean {
		const data = asObject(status);
		if (!data) return false;
		const nextState = asString(data.state) ?? run.state;
		const previousState = run.state;
		const changed = nextState !== previousState;
		if (terminalState(previousState) && !terminalState(nextState)) {
			run.finishedAt = undefined;
			run.terminalLogged = false;
		}
		run.state = nextState;
		run.status = status;
		run.pidAlive = processAlive(data.pid);
		for (const [index, rawStep] of asArray(data.steps).entries()) {
			const step = asObject(rawStep) as AsyncStep | undefined;
			if (step) updateStep(run, step, index);
		}
		if (terminalState(nextState) && !run.terminalLogged) {
			run.finishedAt = Date.now();
			appendLog(
				`${nextState} ${run.label} [${run.id}]`,
				nextState === "complete" || nextState === "completed" ? "success" : "error",
			);
			run.terminalLogged = true;
		}
		return changed;
	}

	function statusFingerprint(status: AsyncStatus): string {
		const data = { ...((asObject(status) ?? {}) as Record<string, unknown>) };
		delete data.lastUpdate;
		return JSON.stringify(data) ?? "";
	}

	function setDiscoverySnapshot(asyncDir: string, snapshot: DiscoverySnapshot): void {
		discoveryCache.delete(asyncDir);
		discoveryCache.set(asyncDir, snapshot);
		while (discoveryCache.size > DISCOVERY_CACHE_LIMIT) {
			const oldest = discoveryCache.keys().next().value as string | undefined;
			if (!oldest) break;
			discoveryCache.delete(oldest);
		}
	}

	function cacheDiscoveryStatus(
		asyncDir: string,
		status: AsyncStatus | undefined,
		mtimeMs?: number,
		size?: number,
		failures = 0,
	): void {
		if (mtimeMs === undefined && size === undefined) {
			try {
				const stat = fs.statSync(path.join(asyncDir, "status.json"));
				mtimeMs = stat.mtimeMs;
				size = stat.size;
			} catch {
				return;
			}
		}
		setDiscoverySnapshot(asyncDir, {
			mtimeMs,
			size,
			status,
			failures,
			retryAt: 0,
		});
	}

	function readDiscoveredStatus(asyncDir: string, now: number): AsyncStatus | undefined {
		const cached = discoveryCache.get(asyncDir);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(path.join(asyncDir, "status.json"));
		} catch {
			if (cached && now < cached.retryAt) return undefined;
			const failures = (cached?.failures ?? 0) + 1;
			const delay = Math.min(
				DISCOVERY_RETRY_MAX_MS,
				DISCOVERY_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 4),
			);
			setDiscoverySnapshot(asyncDir, {
				failures,
				retryAt: now + delay,
			});
			return undefined;
		}

		const unchanged =
			cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size;
		if (unchanged && cached.status) return cached.status;
		if (unchanged && cached && now < cached.retryAt) return undefined;

		const status = readStatus(asyncDir);
		const failures = status ? 0 : unchanged && cached ? cached.failures + 1 : 1;
		const delay = status
			? 0
			: Math.min(
					DISCOVERY_RETRY_MAX_MS,
					DISCOVERY_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 4),
				);
		cacheDiscoveryStatus(asyncDir, status, stat.mtimeMs, stat.size, failures);
		const updated = discoveryCache.get(asyncDir);
		if (updated) updated.retryAt = now + delay;
		return status;
	}

	function refreshSessionUsages(run: TrackedRun, status = run.status): void {
		const now = Date.now();
		if (
			run.sessionUsageCheckedAt !== undefined &&
			now - run.sessionUsageCheckedAt < 1_000
		)
			return;
		run.sessionUsageCheckedAt = now;
		const data = asObject(status);
		const currentIndex = asFiniteNumber(data?.currentStep);
		const fileUsages = new Map<string, TokenUsage | undefined>();
		const readUsage = (fileValue: unknown, startedAt: number): TokenUsage | undefined => {
			const file = safeSessionFile(fileValue);
			if (!file) return undefined;
			if (!fileUsages.has(file))
				fileUsages.set(file, readSessionUsage(run, file, startedAt));
			return fileUsages.get(file);
		};

		run.sessionUsage = undefined;
		for (const [key, snapshot] of run.stepSnapshots) {
			const step = snapshot.latest;
			if (!step) continue;
			const index = Number(key.slice("step:".length));
			const directUsage = tokenUsage(step.tokens ?? step.totalTokens ?? step.usage);
			snapshot.sessionUsage = directUsage
				? undefined
				: readUsage(
						step.sessionFile ??
							(index === currentIndex ? data?.sessionFile : undefined),
						asFiniteNumber(step.startedAt) ??
							(index === currentIndex
								? asFiniteNumber(data?.startedAt)
								: undefined) ??
							run.startedAt,
					);
		}
		if (run.stepSnapshots.size === 0 || currentIndex === undefined)
			run.sessionUsage = readUsage(
				data?.sessionFile,
				asFiniteNumber(data?.startedAt) ?? run.startedAt,
			);
	}

	function pollRuns(includePaused = false): void {
		if (paused) return;
		const now = Date.now();
		let changed = false;
		for (const run of runs.values()) {
			if (
				!run.asyncDir ||
				(terminalState(run.state) && !(includePaused && run.state === "paused")) ||
				isWorkflowRecord(run.status)
			)
				continue;
			const status = readStatus(run.asyncDir);
			if (!status) continue;
			const fingerprint = statusFingerprint(status);
			const previousFingerprint = run.statusFingerprint;
			const previousState = run.state;
			run.statusFingerprint = fingerprint;
			const stateChanged = updateAsyncRun(run, status);
			if (fingerprint !== previousFingerprint || stateChanged) changed = true;
			// updateAsyncRun may set a terminal state; preserve that snapshot in the
			// discovery cache so a later scan cannot resurrect a stale running record.
			if (!terminalState(previousState) && terminalState(run.state))
				cacheDiscoveryStatus(run.asyncDir, status);
		}
		for (const run of runs.values()) {
			if (!terminalState(run.state) && !isWorkflowRecord(run.status))
				refreshSessionUsages(run);
		}

		for (const [id, run] of runs) {
			if (
				run.state !== "paused" &&
				terminalState(run.state) &&
				(run.finishedAt ?? 0) + TERMINAL_RETENTION_MS <= now
			) {
				runs.delete(id);
				changed = true;
			}
		}
		updateStatus();
		if (changed || (activeRuns().length > 0 && now - lastRenderAt >= 1_000))
			refreshUi();
	}

	function nextPollDelay(now: number): number | undefined {
		if (!currentCtx?.hasUI || currentCtx.mode !== "tui" || paused) return undefined;
		let hasAsync = false;
		let hasForeground = false;
		let nextCleanup = Number.POSITIVE_INFINITY;
		for (const run of runs.values()) {
			if (run.asyncDir) {
				if (
					run.state !== "paused" &&
					!terminalState(run.state) &&
					!isWorkflowRecord(run.status)
				)
					hasAsync = true;
			} else if (!terminalState(run.state)) hasForeground = true;
			if (
				run.state !== "paused" &&
				terminalState(run.state) &&
				run.finishedAt !== undefined
			)
				nextCleanup = Math.min(
					nextCleanup,
					run.finishedAt + TERMINAL_RETENTION_MS,
				);
		}
		if (hasAsync) return POLL_INTERVAL_MS;
		if (hasForeground) return FOREGROUND_REFRESH_INTERVAL_MS;
		return Number.isFinite(nextCleanup) ? Math.max(1, nextCleanup - now) : undefined;
	}

	function schedulePoll(): void {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		const delay = nextPollDelay(Date.now());
		if (delay === undefined) return;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			pollRuns();
			schedulePoll();
		}, delay);
		pollTimer.unref?.();
	}

	function stopPollTimer(): void {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	}

	function stopDiscoveryTimer(): void {
		if (discoveryTimer) clearTimeout(discoveryTimer);
		discoveryTimer = undefined;
	}

	function clearTimers(): void {
		stopPollTimer();
		stopDiscoveryTimer();
	}

	function scheduleDiscovery(): void {
		stopDiscoveryTimer();
		if (!currentCtx?.hasUI || currentCtx.mode !== "tui" || paused) return;
		discoveryTimer = setTimeout(() => {
			discoveryTimer = undefined;
			const ctx = currentCtx;
			if (!ctx || paused) return;
			const changed = discoverExistingRuns(ctx);
			if (changed) refreshUi();
			schedulePoll();
			scheduleDiscovery();
		}, DISCOVERY_INTERVAL_MS);
		discoveryTimer.unref?.();
	}

	function discoverExistingRuns(
		ctx: ExtensionContext,
		skipTracked = false,
	): boolean {
		let changed = false;
		let scannedRuns = 0;
		const sessionId = (() => {
			try {
				return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
			} catch {
				return undefined;
			}
		})();
		try {
			for (const rootEntry of fs.readdirSync(os.tmpdir(), {
				withFileTypes: true,
			})) {
				if (!rootEntry.isDirectory() || !rootEntry.name.startsWith("pi-subagents-"))
					continue;
				const root = path.join(os.tmpdir(), rootEntry.name, "async-subagent-runs");
				let entries: fs.Dirent[];
				try {
					entries = fs.readdirSync(root, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const asyncDir = path.join(root, entry.name);
					const tracked = [...runs.values()].find(
						(run) => run.asyncDir === asyncDir,
					);
					if (skipTracked && tracked) continue;
					if (tracked && tracked.state !== "paused") {
						if (terminalState(tracked.state) || tracked.status) continue;
					}
					const status =
						tracked && tracked.state !== "paused" && tracked.status
							? tracked.status
							: readDiscoveredStatus(asyncDir, Date.now());
					const data = asObject(status);
					const state = asString(data?.state);
					const trackedPausedTerminal =
						tracked?.state === "paused" &&
						state !== "paused" &&
						terminalState(state ?? "");
					if (
						!data ||
						(!["queued", "running", "paused"].includes(state ?? "") &&
							!trackedPausedTerminal)
					)
						continue;
					if (isWorkflowRecord(status)) continue;
					const pid = asFiniteNumber(data.pid);
					if (state === "running" && pid !== undefined && processAlive(pid) === false)
						continue;
					if (
						sessionId &&
						asString(data.sessionId) &&
						asString(data.sessionId) !== sessionId
					)
						continue;

					const id = asString(data.runId) ?? entry.name;
					const existing = tracked ?? runs.get(id);
					if (existing) {
						const previousState = existing.state;
						const previousFingerprint = existing.statusFingerprint;
						const fingerprint = statusFingerprint(status);
						if (previousState === "paused" && state !== "paused") {
							existing.finishedAt = undefined;
							existing.terminalLogged = false;
						}
						existing.asyncDir = asyncDir;
						existing.status = status;
						existing.statusFingerprint = fingerprint;
						existing.pidAlive = processAlive(data.pid);
						if (fingerprint !== previousFingerprint) changed = true;
						if (updateAsyncRun(existing, status)) changed = true;
						if (
							(!terminalState(previousState) && terminalState(existing.state)) ||
							(previousState === "paused" && existing.state !== "paused")
						)
							cacheDiscoveryStatus(asyncDir, status);
						if (terminalState(previousState) && !terminalState(existing.state))
							changed = true;
						if (!terminalState(existing.state)) refreshSessionUsages(existing, status);
					} else {
						trackAsyncStarted(
							{ id, asyncDir, agent: data.agent ?? data.agents },
							"scan",
						);
						const run = runs.get(id);
						if (run) {
							run.status = status;
							run.statusFingerprint = statusFingerprint(status);
							run.pidAlive = processAlive(data.pid);
							updateAsyncRun(run, status);
							refreshSessionUsages(run, status);
							changed = true;
						}
					}
					if (++scannedRuns >= MAX_SCAN_RUNS) return changed;
				}
			}
		} catch {
			// /tmp scanning is best-effort; event subscription remains authoritative for new runs.
		}
		return changed;
	}

	function foregroundStart(event: { toolCallId: string; args?: unknown }): void {
		const id = `foreground:${event.toolCallId}`;
		if (runs.has(id)) return;
		const args = asObject(event.args);
		const label = formatAgent(args?.agent ?? args?.agents, "foreground subagent");
		const model = asString(args?.model);
		const run: TrackedRun = {
			id,
			label,
			...(model ? { model } : {}),
			foreground: true,
			state: "running",
			startedAt: Date.now(),
			terminalLogged: false,
			stepSnapshots: new Map(),
			sessionTokenSnapshots: new Map(),
		};
		rememberRun(run);
		appendLog("started foreground subagent", "info");
		refreshUi();
		schedulePoll();
	}

	function foregroundUpdate(event: {
		toolCallId: string;
		partialResult: unknown;
	}): void {
		const run = runs.get(`foreground:${event.toolCallId}`);
		if (!run) return;
		const details = asObject(asObject(event.partialResult)?.details);
		if (!details) return;
		for (const [index, rawProgress] of asArray(details.progress).entries()) {
			const progress = asObject(rawProgress) as AsyncStep | undefined;
			if (progress) updateStep(run, progress, index);
		}
		for (const [index, rawResult] of asArray(details.results).entries()) {
			const result = asObject(rawResult);
			const progress = asObject(result?.progress) as AsyncStep | undefined;
			if (progress) updateStep(run, progress, index);
		}
		requestRender();
	}

	function attachAsyncRun(run: TrackedRun, reference: AsyncReference): void {
		const existing = runs.get(reference.id);
		if (existing && existing !== run) {
			runs.delete(run.id);
			existing.asyncDir = reference.asyncDir;
			existing.foreground = false;
			if (currentCtx?.hasUI && currentCtx.mode === "tui" && !paused)
				pollRuns();
			refreshUi();
			schedulePoll();
			return;
		}
		runs.delete(run.id);
		run.id = reference.id;
		run.label = formatAgent(reference.agent, "subagent");
		run.asyncDir = reference.asyncDir;
		run.foreground = false;
		run.terminalLogged = false;
		run.finishedAt = undefined;
		run.status = readStatus(reference.asyncDir);
		run.statusFingerprint = run.status
			? statusFingerprint(run.status)
			: undefined;
		run.state = asString(asObject(run.status)?.state) ?? "running";
		run.pidAlive = processAlive(asObject(run.status)?.pid);
		runs.set(run.id, run);
		if (run.status) {
			updateAsyncRun(run, run.status);
			refreshSessionUsages(run, run.status);
		}
		appendLog(`attached ${run.label} [${run.id}]`, "info");
		refreshUi();
		schedulePoll();
	}

	function foregroundEnd(event: {
		toolCallId: string;
		isError: boolean;
		result: unknown;
	}): void {
		const run = runs.get(`foreground:${event.toolCallId}`);
		if (!run) return;
		const reference = event.isError
			? undefined
			: extractAsyncReference(event.result);
		if (reference) {
			attachAsyncRun(run, reference);
			return;
		}
		run.state = event.isError ? "failed" : "complete";
		run.finishedAt = Date.now();
		run.terminalLogged = true;
		appendLog(
			event.isError
				? "foreground subagent failed"
				: "foreground subagent complete",
			event.isError ? "error" : "success",
		);
		refreshUi();
		schedulePoll();
	}

	pi.events.on(ASYNC_STARTED_EVENT, (payload) => {
		trackAsyncStarted(payload, "event");
		if (currentCtx?.hasUI && currentCtx.mode === "tui" && !paused) pollRuns();
		else refreshUi();
		schedulePoll();
	});
	pi.events.on(ASYNC_COMPLETE_EVENT, (payload) => trackAsyncComplete(payload));

	pi.on("tool_execution_start", (event) => {
		if (event.toolName === "subagent") foregroundStart(event);
	});
	pi.on("tool_execution_update", (event) => {
		if (event.toolName === "subagent") foregroundUpdate(event);
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "subagent") foregroundEnd(event);
	});

	pi.on("session_start", (_event, ctx) => {
		clearTimers();
		try {
			if (currentCtx) {
				removeWidget(currentCtx);
				currentCtx.ui.setStatus(STATUS_ID, undefined);
			}
		} catch {
			// Best effort during session replacement.
		}
		currentCtx = ctx;
		widgetInstalled = false;
		lastStatusText = undefined;
		lastRenderAt = 0;
		visible = true;
		paused = false;
		logs = [];
		runs.clear();
		discoveryCache.clear();
		if (ctx.hasUI && ctx.mode === "tui") {
			discoverExistingRuns(ctx);
			refreshUi();
			schedulePoll();
			scheduleDiscovery();
		}
	});

	pi.on("session_shutdown", () => {
		clearTimers();
		try {
			if (currentCtx) removeWidget(currentCtx);
			currentCtx?.ui.setStatus(STATUS_ID, undefined);
		} catch {
			// Best effort during shutdown.
		}
		widgetInstalled = false;
		lastStatusText = undefined;
		currentCtx = undefined;
		runs.clear();
		discoveryCache.clear();
	});

	pi.registerCommand("subagent-tail", {
		description: "切换子代理面板：on/off/pause/resume/clear/lines N（N 为底部滚动日志行数）",
		handler: async (args, ctx) => {
			const [command, value] = args.trim().split(/\s+/, 2);
			const normalizedCommand = (command || "toggle").toLowerCase();
			switch (normalizedCommand) {
				case "on":
					visible = true;
					paused = false;
					break;
				case "off":
					visible = false;
					break;
				case "pause":
					paused = true;
					break;
				case "resume":
					paused = false;
					break;
				case "clear":
					logs = [];
					break;
				case "lines": {
					const parsed = Number(value);
					if (
						Number.isInteger(parsed) &&
						parsed >= MIN_TAIL_LINES &&
						parsed <= MAX_TAIL_LINES
					)
						tailLines = parsed;
					else
						ctx.ui.notify(
							`lines 范围为 ${MIN_TAIL_LINES}-${MAX_TAIL_LINES}`,
							"warning",
						);
					break;
				}
				case "toggle":
				default:
					visible = !visible;
					break;
			}
			if (ctx.hasUI) {
				if (normalizedCommand === "pause") {
					clearTimers();
					refreshUi();
					return;
				}
				if (
					normalizedCommand === "resume" ||
					normalizedCommand === "on" ||
					(normalizedCommand === "toggle" && visible)
				) {
					if (currentCtx?.mode === "tui" && !paused) {
						pollRuns(true);
						discoverExistingRuns(currentCtx, true);
					}
				}
				refreshUi();
				schedulePoll();
				scheduleDiscovery();
			}
		},
	});
}
