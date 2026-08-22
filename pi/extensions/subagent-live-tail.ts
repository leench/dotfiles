import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WIDGET_ID = "subagent-live-tail";
const STATUS_ID = "subagent-live-tail-status";
const POLL_INTERVAL_MS = 100;
const DISCOVERY_INTERVAL_MS = 500;
const MIN_TAIL_LINES = 1;
const DEFAULT_TAIL_LINES = 5;
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
	stepSnapshots: Map<string, StepSnapshot>;
	sessionTokenSnapshots: Map<string, SessionTokenSnapshot>;
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
): { roles: string[]; models: string[]; thinkings: string[] } {
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
	const models = [
		...new Set(
			identitySteps
				.map((step) => asString(step.model))
				.filter((value): value is string => Boolean(value)),
		),
	];
	const thinkings = [
		...new Set(
			identitySteps
				.map((step) => asString(step.thinking))
				.filter((value): value is string => Boolean(value)),
		),
	];
	if (roles.length === 0)
		roles.push(formatAgent(data?.agent ?? data?.agents, run.label));
	if (models.length === 0) {
		const model = run.model ?? asString(data?.model);
		if (model) models.push(model);
	}
	if (thinkings.length === 0) {
		const thinking = asString(data?.thinking);
		if (thinking) thinkings.push(thinking);
	}
	return { roles, models, thinkings };
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
	const pidState = processAlive(data?.pid);
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
			prefix = pidState === false ? "x" : "!";
			marker = pidState === false ? "DEAD" : "STALLED";
		} else if (canStall && idleFor >= STALL_WARNING_MS) {
			prefix = "~";
			marker = "IDLE";
		}

		const label = formatAgent(
			step?.agent ?? step?.label ?? (isCurrent ? data?.agent ?? data?.agents : undefined),
			run.label,
		);
		const parts = [
			run.foreground ? "sync" : "async",
			`up ${formatDuration(now - startedAt)}`,
			`last ${formatDuration(idleFor)} ago`,
		];
		if (observed.length > 1 && candidate.index >= 0)
			parts.push(`step ${candidate.index + 1}/${observed.length}`);
		const model = asString(step?.model) ?? (isCurrent ? run.model ?? asString(data?.model) : undefined);
		const thinking = asString(step?.thinking) ?? (isCurrent ? asString(data?.thinking) : undefined);
		if (model) parts.push(`model ${preview(model, 42)}${thinking ? ` ${thinking}` : ""}`);
		else if (thinking) parts.push(thinking);
		if (activityState && activityState !== state) parts.push(activityState);
		if (mode && observed.length <= 1) parts.push(mode);
		const toolCount = asFiniteNumber(step?.toolCount ?? (isCurrent ? data?.toolCount : undefined));
		if (toolCount !== undefined) parts.push(`tools ${toolCount}`);
		const turnCount = asFiniteNumber(step?.turnCount ?? (isCurrent ? data?.turnCount : undefined));
		if (turnCount !== undefined) parts.push(`turns ${turnCount}`);
		const sessionFile = step?.sessionFile ?? (isCurrent ? data?.sessionFile : undefined);
		const usage =
			tokenUsage(step?.tokens ?? step?.totalTokens ?? step?.usage) ??
			(isCurrent
				? tokenUsage(data?.totalTokens ?? data?.tokens ?? data?.usage ?? data?.n)
				: undefined) ??
			readSessionUsage(run, sessionFile, startedAt);
		if (usage) parts.push(formatTokenUsage(usage));
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
			const processHint = pidState === false ? "; process not found" : "";
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

function requestRender(ctx: ExtensionContext | undefined): void {
	try {
		(ctx?.ui as unknown as { requestRender?: () => void })?.requestRender?.();
	} catch {
		// Session replacement can invalidate the old UI context. The next session_start repairs it.
	}
}

export default function subagentLiveTail(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let widgetInstalled = false;
	let lastDiscoveryAt = 0;
	let visible = true;
	let paused = false;
	let tailLines = DEFAULT_TAIL_LINES;
	let logs: LogEntry[] = [];
	const runs = new Map<string, TrackedRun>();

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
		return [...runs.values()].filter((run) => !terminalState(run.state));
	}

	function activeChildCount(active: TrackedRun[]): number {
		return active.reduce((count, run) => {
			const status = run.asyncDir ? readStatus(run.asyncDir) : undefined;
			const steps = observedSteps(run, status);
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
		if (childCount === 0) {
			currentCtx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		let suffix = "";
		if (paused) suffix = " paused";
		else if (!visible) suffix = " off";
		const plural = childCount === 1 ? "" : "s";
		currentCtx.ui.setStatus(STATUS_ID, `${childCount} subagent${plural}${suffix}`);
	}

	function renderPanel(width: number, theme: ThemeLike): string[] {
		if (!visible) return [];
		const active = activeRuns();
		if (active.length === 0 && logs.length === 0) return [];

		const activeStatuses = active.map((run) => ({
			run,
			status: run.asyncDir ? readStatus(run.asyncDir) : undefined,
		}));
		const activeChildTotal = activeChildCount(active);
		const identities = activeStatuses.map(({ run, status }) =>
			runIdentity(run, status),
		);
		const roles = [
			...new Set(identities.flatMap((identity) => identity.roles)),
		];
		const models = [
			...new Set(identities.flatMap((identity) => identity.models)),
		];
		const thinkings = [
			...new Set(identities.flatMap((identity) => identity.thinkings)),
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
						: theme.fg("accent", "unknown")) +
					theme.fg(
						"accent",
						` · model ${models.join("+") || "unknown"} · thinking ${thinkings.join("+") || "unknown"}`,
					)
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
					lines.push(
						theme.fg(markerColor, `${detail.prefix} ${detail.marker}`) +
							theme.fg(roleColor, ` ${detail.label}`) +
							theme.fg("muted", ` · ${detail.suffix}`),
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
				(_tui, theme) => ({
					render: (width: number) => renderPanel(width, theme),
					invalidate: () => undefined,
				}),
				{ placement: "aboveEditor" },
			);
			widgetInstalled = true;
		}
		updateStatus();
		requestRender(ctx);
	}

	function removeWidget(ctx: ExtensionContext): void {
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
		requestRender(currentCtx);
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
		if (!run.terminalLogged) {
			appendLog(
				`${state} ${run.label} [${id}]`,
				state === "complete" || state === "completed" ? "success" : "error",
			);
			run.terminalLogged = true;
		}
		refreshUi();
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
		const changed = nextState !== run.state;
		run.state = nextState;
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

	function pollRuns(): void {
		const now = Date.now();
		if (currentCtx && now - lastDiscoveryAt >= DISCOVERY_INTERVAL_MS) {
			discoverExistingRuns(currentCtx);
			lastDiscoveryAt = now;
			installWidget(currentCtx);
		}
		if (!paused) {
			for (const run of runs.values()) {
				if (!run.asyncDir) continue;
				const status = readStatus(run.asyncDir);
				if (status) updateAsyncRun(run, status);
			}
		}
		const cutoff = now - TERMINAL_RETENTION_MS;
		for (const [id, run] of runs) {
			if (terminalState(run.state) && (run.finishedAt ?? 0) < cutoff)
				runs.delete(id);
		}
		if (activeRuns().length === 0) refreshUi();
		else {
			updateStatus();
			requestRender(currentCtx);
		}
	}

	function schedulePoll(): void {
		if (!currentCtx?.hasUI || currentCtx.mode !== "tui") return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			pollRuns();
			schedulePoll();
		}, POLL_INTERVAL_MS);
		timer.unref?.();
	}

	function discoverExistingRuns(ctx: ExtensionContext): void {
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
					const status = readStatus(asyncDir);
					const data = asObject(status);
					const state = asString(data?.state);
					if (!data || !["queued", "running"].includes(state ?? "")) continue;
					const pid = asFiniteNumber(data.pid);
					if (state === "running" && pid !== undefined && processAlive(pid) === false)
						continue;
					if (
						sessionId &&
						asString(data.sessionId) &&
						asString(data.sessionId) !== sessionId
					)
						continue;
					trackAsyncStarted(
						{
							id: data.runId ?? entry.name,
							asyncDir,
							agent: data.agent ?? data.agents,
						},
						"scan",
					);
					if (runs.size >= MAX_SCAN_RUNS) return;
				}
			}
		} catch {
			// /tmp scanning is best-effort; event subscription remains authoritative for new runs.
		}
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
		requestRender(currentCtx);
	}

	function attachAsyncRun(run: TrackedRun, reference: AsyncReference): void {
		const existing = runs.get(reference.id);
		if (existing && existing !== run) {
			runs.delete(run.id);
			existing.asyncDir = reference.asyncDir;
			existing.foreground = false;
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
		run.state = asString(readStatus(reference.asyncDir)?.state) ?? "running";
		runs.set(run.id, run);
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
	}

	pi.events.on(ASYNC_STARTED_EVENT, (payload) => {
		trackAsyncStarted(payload, "event");
		refreshUi();
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
		if (ctx.hasUI && ctx.mode === "tui") removeWidget(ctx);
		currentCtx = ctx;
		widgetInstalled = false;
		lastDiscoveryAt = 0;
		visible = true;
		paused = false;
		logs = [];
		runs.clear();
		if (ctx.hasUI && ctx.mode === "tui") {
			discoverExistingRuns(ctx);
			refreshUi();
			schedulePoll();
		}
	});

	pi.on("session_shutdown", () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		try {
			if (currentCtx) removeWidget(currentCtx);
			currentCtx?.ui.setStatus(STATUS_ID, undefined);
		} catch {
			// Best effort during shutdown.
		}
		widgetInstalled = false;
		currentCtx = undefined;
	});

	pi.registerCommand("subagent-tail", {
		description: "切换子代理面板：on/off/pause/resume/clear/lines N（N 为底部滚动日志行数）",
		handler: async (args, ctx) => {
			const [command, value] = args.trim().split(/\s+/, 2);
			switch ((command || "toggle").toLowerCase()) {
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
			if (ctx.hasUI) refreshUi();
		},
	});
}
