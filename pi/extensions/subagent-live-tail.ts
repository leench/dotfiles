import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WIDGET_ID = "subagent-live-tail";
const STATUS_ID = "subagent-live-tail-status";
const POLL_INTERVAL_MS = 150;
const DISCOVERY_INTERVAL_MS = 1_000;
const MIN_TAIL_LINES = 4;
const DEFAULT_TAIL_LINES = 12;
const MAX_TAIL_LINES = 32;
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

type StepSnapshot = {
	tool?: string;
	output: string[];
};

type AsyncStep = {
	agent?: unknown;
	model?: unknown;
	status?: unknown;
	currentTool?: unknown;
	currentToolArgs?: unknown;
	currentPath?: unknown;
	recentOutput?: unknown;
	recentTools?: unknown;
	lastActivityAt?: unknown;
	toolCount?: unknown;
	turnCount?: unknown;
};

type AsyncStatus = {
	runId?: unknown;
	state?: unknown;
	mode?: unknown;
	agent?: unknown;
	agents?: unknown;
	model?: unknown;
	startedAt?: unknown;
	lastUpdate?: unknown;
	deadlineAt?: unknown;
	currentTool?: unknown;
	currentToolArgs?: unknown;
	currentPath?: unknown;
	recentOutput?: unknown;
	recentTools?: unknown;
	toolCount?: unknown;
	turnCount?: unknown;
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
};

type ThemeColor = "accent" | "muted" | "success" | "error" | "dim" | "text";

type ThemeLike = {
	fg: (color: ThemeColor, text: string) => string;
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
	if (pathValue) return `${toolName} ${shortenPath(pathValue)}`;
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

function runIdentity(
	run: TrackedRun,
	status: AsyncStatus | undefined,
): { roles: string[]; models: string[] } {
	const data = asObject(status);
	const steps = statusSteps(status);
	const runningSteps = steps.filter(
		(step) => asString(step.status) === "running",
	);
	const identitySteps = runningSteps.length > 0 ? runningSteps : steps.slice(0, 1);
	const roles = [
		...new Set(identitySteps.map((step) => formatAgent(step.agent, run.label))),
	];
	const models = [
		...new Set(
			identitySteps
				.map((step) => asString(step.model))
				.filter((value): value is string => Boolean(value)),
		),
	];
	if (roles.length === 0)
		roles.push(formatAgent(data?.agent ?? data?.agents, run.label));
	if (models.length === 0) {
		const model = run.model ?? asString(data?.model);
		if (model) models.push(model);
	}
	return { roles, models };
}

function latestActivityAt(
	run: TrackedRun,
	status: AsyncStatus | undefined,
	steps: AsyncStep[],
): number {
	const data = asObject(status);
	const timestamps = [
		asFiniteNumber(data?.startedAt),
		asFiniteNumber(data?.lastUpdate),
		...steps.map((step) => asFiniteNumber(step.lastActivityAt)),
	].filter((value): value is number => value !== undefined);
	return timestamps.length > 0 ? Math.max(...timestamps) : run.startedAt;
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
): string[] {
	const data = asObject(status);
	const steps = statusSteps(status);
	const currentIndex = steps.findIndex(
		(step) => asString(step.status) === "running",
	);
	const currentStep = steps[Math.max(0, currentIndex)];
	const tool = currentStep?.currentTool ?? data?.currentTool;
	const args = currentStep?.currentToolArgs ?? data?.currentToolArgs;
	const currentPath = currentStep?.currentPath ?? data?.currentPath;
	const activity = formatTool(tool, args, currentPath);
	const label = formatAgent(
		currentStep?.agent ?? data?.agent ?? data?.agents,
		run.label,
	);
	const startedAt = asFiniteNumber(data?.startedAt) ?? run.startedAt;
	const lastActivity = latestActivityAt(run, status, steps);
	const idleFor = Math.max(0, now - lastActivity);
	let marker = "●";
	if (idleFor >= STALL_CRITICAL_MS) marker = "⛔ stalled";
	else if (idleFor >= STALL_WARNING_MS) marker = "⚠ idle";
	const lines = [
		`${marker} ${label} · ${run.state} · up ${formatDuration(now - startedAt)} · last ${formatDuration(idleFor)} ago`,
	];
	if (activity !== "working") lines.push(`  tool: ${activity}`);
	const counters: string[] = [];
	if (steps.length > 0)
		counters.push(`step ${Math.max(0, currentIndex) + 1}/${steps.length}`);
	const mode = asString(data?.mode);
	if (mode) counters.push(`mode ${mode}`);
	const toolCount = asFiniteNumber(currentStep?.toolCount ?? data?.toolCount);
	if (toolCount !== undefined) counters.push(`tools ${toolCount}`);
	const turnCount = asFiniteNumber(currentStep?.turnCount ?? data?.turnCount);
	if (turnCount !== undefined) counters.push(`turns ${turnCount}`);
	if (counters.length > 0) lines.push(`  ${counters.join(" · ")}`);
	const output = latestOutput(status, steps);
	if (output) lines.push(`  ↳ ${output}`);
	if (idleFor >= STALL_WARNING_MS)
		lines.push(`  no status update for ${formatDuration(idleFor)}`);
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

	function updateStatus(): void {
		if (!currentCtx?.hasUI || currentCtx.mode !== "tui") return;
		const active = activeRuns().length;
		if (active === 0) {
			currentCtx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		let suffix = "";
		if (paused) suffix = " paused";
		else if (!visible) suffix = " off";
		const plural = active === 1 ? "" : "s";
		currentCtx.ui.setStatus(STATUS_ID, `${active} subagent${plural}${suffix}`);
	}

	function renderPanel(width: number, theme: ThemeLike): string[] {
		if (!visible) return [];
		const active = activeRuns();
		if (active.length === 0 && logs.length === 0) return [];

		const activeStatuses = active.map((run) => ({
			run,
			status: run.asyncDir ? readStatus(run.asyncDir) : undefined,
		}));
		const identities = activeStatuses.map(({ run, status }) =>
			runIdentity(run, status),
		);
		const roles = [
			...new Set(identities.flatMap((identity) => identity.roles)),
		];
		const models = [
			...new Set(identities.flatMap((identity) => identity.models)),
		];
		const identitySuffix =
			active.length > 0
				? ` · role ${roles.join("+") || "unknown"} · model ${models.join("+") || "unknown"}`
				: "";
		const lines: string[] = [];
		const activeLabel = active.length > 0 ? `${active.length} active` : "idle";
		lines.push(
			theme.fg(
				"accent",
				`▣ subagent tail · ${activeLabel} · poll ${POLL_INTERVAL_MS}ms${identitySuffix}${paused ? " · paused" : ""}`,
			),
		);

		const now = Date.now();
		for (const { run, status } of activeStatuses.slice(0, 4)) {
			for (const detail of runDetailLines(run, status, now)) {
				let color: ThemeColor = "muted";
				if (detail.startsWith("⛔")) color = "error";
				else if (detail.startsWith("⚠")) color = "accent";
				lines.push(theme.fg(color, detail));
			}
		}
		if (active.length > 4)
			lines.push(theme.fg("dim", `  +${active.length - 4} more subagents`));

		const available = Math.max(0, tailLines - lines.length);
		const tail = logs.slice(-available);
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
			lines.push(theme.fg(color, `  ${entry.text}`));
		}

		const limit = Math.max(1, tailLines);
		const content =
			lines.length > limit ? [lines[0], ...lines.slice(-(limit - 1))] : lines;
		return [
			...Array.from({ length: TOP_GAP_LINES }, () => ""),
			...content.map((line) => truncateToWidth(line, Math.max(1, width), "")),
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
				state === "complete" ? "success" : "error",
			);
			run.terminalLogged = true;
		}
		refreshUi();
	}

	function appendNewOutput(run: TrackedRun, key: string, value: unknown): void {
		const lines = asArray(value).map(sanitizeLine).filter(Boolean);
		if (lines.length === 0) return;
		const previous = run.stepSnapshots.get(key) ?? { output: [] };
		let start = Math.max(0, lines.length - 3);
		const previousLast = previous.output.at(-1);
		if (previousLast) {
			const index = lines.lastIndexOf(previousLast);
			if (index >= 0) start = index + 1;
		}
		for (const line of lines.slice(start))
			appendLog(`${run.label}: ${line}`, "dim");
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
		if (currentTool && currentTool !== previous.tool) {
			appendLog(
				`${formatAgent(step.agent, run.label)} → ${formatTool(currentTool, step.currentToolArgs, step.currentPath)}`,
				"info",
			);
		}
		if (!currentTool && previous.tool)
			appendLog(`${formatAgent(step.agent, run.label)} ← tool finished`, "dim");
		previous.tool = currentTool;
		run.stepSnapshots.set(key, previous);
		appendNewOutput(run, key, step.recentOutput);
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
				return ctx.sessionManager.getSessionId();
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
					if (!data || asString(data.state) !== "running") continue;
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
		description: "切换子代理实时滚动面板：on/off/pause/resume/clear/lines N",
		handler: (args, ctx) => {
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
