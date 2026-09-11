import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsTool,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	type BashOperations,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { SshConnectionError, SshTimeoutError, SshTransport, shQuote, type SshTarget } from "./remote.ts";

const ENV_ALIAS = "PI_SSH_WORKSPACE";
const ENV_ANCHOR = "PI_SSH_LOCAL_ANCHOR";

interface RemoteState {
	target: SshTarget;
	anchor: string;
}

interface WorkspaceSessionState {
	version: 1;
	connected: boolean;
	alias?: string;
	sessionNameManaged?: boolean;
	sessionNameBefore?: string | null;
}

const SESSION_STATE_TYPE = "pi-ssh-workspace";

function isWorkspaceSessionState(value: unknown): value is WorkspaceSessionState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	if (state.version !== 1 || typeof state.connected !== "boolean") return false;
	if (state.connected && typeof state.alias !== "string") return false;
	if (state.sessionNameManaged !== undefined && typeof state.sessionNameManaged !== "boolean") return false;
	if (
		state.sessionNameBefore !== undefined &&
		state.sessionNameBefore !== null &&
		typeof state.sessionNameBefore !== "string"
	) {
		return false;
	}
	return true;
}

function readWorkspaceSessionState(ctx: ExtensionContext): WorkspaceSessionState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== SESSION_STATE_TYPE) continue;
		if (isWorkspaceSessionState(entry.data)) return entry.data;
	}
	return undefined;
}

function legacyAliasForSessionName(sessionName: string | undefined): string | undefined {
	if (!sessionName) return undefined;
	try {
		const config = loadConfig();
		for (const [alias, entry] of Object.entries(config.aliases)) {
			if (entry.path === undefined) continue;
			const displayName = `${entry.host}${entry.port === undefined ? "" : `:${entry.port}`}:${entry.path}`;
			if (displayName === sessionName) return alias;
		}
	} catch {
		// A normal local session must not fail just because the optional config is absent or invalid.
	}
	return undefined;
}

// Process-level state is still used by background subagent runner processes.
// The active session binding itself is persisted separately in the session branch.
const transport = new SshTransport();
let remote: RemoteState | undefined;

// Set when an env/flag-derived connection fails at startup. In this state every
// tool call fails loudly instead of silently falling back to the local
// filesystem — a background subagent that thinks it is remote must never edit
// local files.
let blocked: { alias: string; reason: string } | undefined;

function localAnchor(): string {
	return process.env[ENV_ANCHOR] || process.cwd();
}

function statusText(): string {
	// Short by design: the remote target itself is carried by the session name
	// (see applySessionName), so the statusline only needs to show the mode.
	return "SSH: connected";
}

/** `host[:port]:/remote/root` — the same shape an SSH target uses. */
function remoteDisplayName(state: RemoteState): string {
	const { host, port, remoteRoot } = state.target;
	return `${host}${port === undefined ? "" : `:${port}`}:${remoteRoot}`;
}

function applyEnv(state: RemoteState | undefined): void {
	if (state) {
		process.env[ENV_ALIAS] = state.target.alias;
		process.env[ENV_ANCHOR] = state.anchor;
	} else {
		delete process.env[ENV_ALIAS];
		delete process.env[ENV_ANCHOR];
	}
}

function updateStatus(ctx: ExtensionContext | undefined, state: RemoteState | undefined): void {
	if (!ctx?.hasUI) return;
	ctx.ui.setStatus("ssh-workspace", state ? ctx.ui.theme.fg("success", statusText()) : undefined);
}

async function connectTarget(alias: string, anchor: string): Promise<RemoteState> {
	const config = loadConfig();
	const entry = config.aliases[alias];
	if (!entry) {
		throw new Error(`别名 "${alias}" 不在 ~/.pi/agent/ssh-workspace.json 里`);
	}
	const target: SshTarget = { alias, host: entry.host, port: entry.port, remoteRoot: entry.path ?? "" };
	try {
		await transport.check(target);
		if (!target.remoteRoot) {
			target.remoteRoot = await transport.resolveRemoteRoot(target);
		}
	} catch (error) {
		const detail = error instanceof SshConnectionError ? error.message : String(error);
		throw new Error(`连接 ${alias} 失败: ${detail}`);
	}
	return { target, anchor };
}

/**
 * Resolve the active tool-routing state. Throws when the workspace is blocked
 * (startup connection failure): tools must fail loudly, never fall back to the
 * local filesystem. Returns undefined in plain local mode.
 */
function resolveState(): RemoteState | undefined {
	if (blocked) {
		throw new Error(
			`SSH workspace "${blocked.alias}" 不可用（${blocked.reason}）。工具不会回退到本地文件系统；请修复连接后用 /ssh ${blocked.alias} 重试，或 /ssh exit 回到本地。`,
		);
	}
	return remote;
}

/** Map a local absolute path to its remote counterpart. Outside-anchor paths pass through. */
function toRemote(state: RemoteState, absolutePath: string): string {
	if (absolutePath === state.anchor) return state.target.remoteRoot;
	if (absolutePath.startsWith(state.anchor + "/")) {
		return state.target.remoteRoot + absolutePath.slice(state.anchor.length);
	}
	return absolutePath;
}

function remoteReadOps(state: RemoteState): ReadOperations {
	const to = (p: string) => toRemote(state, p);
	return {
		readFile: (p) => transport.readFile(state.target, to(p)),
		access: async (p) => {
			const r = await transport.exec(state.target, `test -r ${shQuote(to(p))}`, state.target.remoteRoot, { timeoutMs: 15_000 });
			if (r.exitCode !== 0) throw new Error(`不可读: ${to(p)}`.trim());
		},
		detectImageMimeType: async (p) => {
			const r = await transport.exec(state.target, `file --mime-type -b ${shQuote(to(p))}`, state.target.remoteRoot, { timeoutMs: 15_000 });
			if (r.exitCode !== 0) return null;
			const mime = r.stdout.trim();
			return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
		},
	};
}

function remoteWriteOps(state: RemoteState): WriteOperations {
	const to = (p: string) => toRemote(state, p);
	return {
		writeFile: (p, content) => transport.writeFile(state.target, to(p), content),
		mkdir: async (dir) => {
			const r = await transport.exec(state.target, `mkdir -p ${shQuote(to(dir))}`, state.target.remoteRoot, { timeoutMs: 15_000 });
			if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `mkdir ${to(dir)} 失败`);
		},
	};
}

function remoteEditOps(state: RemoteState): EditOperations {
	const read = remoteReadOps(state);
	const write = remoteWriteOps(state);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function remoteBashOps(state: RemoteState): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				transport.exec(state.target, command, toRemote(state, cwd), {
					timeoutMs: timeout ? timeout * 1000 : undefined,
					signal,
					onData,
				}).then(
					(r) => {
						if (signal?.aborted) reject(new Error("aborted"));
						else resolve({ exitCode: r.exitCode });
					},
					(error) => {
						// Match the builtin shell tool's timeout convention so pi renders it as a timeout.
						if (error instanceof SshTimeoutError) reject(new Error(`timeout:${timeout}`));
						else reject(error);
					},
				);
			}),
	};
}

function remoteFindOps(state: RemoteState): FindOperations {
	const to = (p: string) => toRemote(state, p);
	return {
		exists: async (p) => {
			const r = await transport.exec(state.target, `test -e ${shQuote(to(p))}`, state.target.remoteRoot, { timeoutMs: 15_000 });
			return r.exitCode === 0;
		},
		glob: async (pattern, cwd, { ignore, limit }) => {
			// The pattern is a path glob (*.ts, **/*.json, src/**/*.spec.ts), so run
			// from the search dir and prefer rg --files (respects .gitignore, supports
			// **), then fd, then find -path (find's * crosses /, matching ** semantics).
			const ignoreFlags = (ignore ?? []).map((entry) => `-g '!${entry}' `).join("");
			const findIgnores = (ignore ?? []).map((entry) => ` -not -path '*/${entry}'`).join("");
			// find's -path * crosses /, so **/ collapses to */ without loss.
			const findPattern = pattern.replace(/\*\*\//g, "*");
			const cmd = [
				`if command -v rg >/dev/null 2>&1; then`,
				`  rg --files --glob ${shQuote(pattern)} ${ignoreFlags}. | head -n ${limit};`,
				`elif command -v fd >/dev/null 2>&1; then`,
				`  fd --glob ${shQuote(pattern)} ${(ignore ?? []).map((entry) => `--exclude ${shQuote(entry)}`).join(" ")} | head -n ${limit};`,
				`else`,
				`  find . -path ${shQuote(`./${findPattern}`)} -type f${findIgnores} | head -n ${limit};`,
				`fi`,
			].join("\n");
			const r = await transport.exec(state.target, cmd, to(cwd), { timeoutMs: 30_000 });
			if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(r.stderr.trim() || `find 失败 (${r.exitCode})`);
			return r.stdout.split("\n").filter(Boolean).map((line) => (line.startsWith("./") ? line.slice(2) : line));
		},
	};
}

function remoteLsOps(state: RemoteState): LsOperations {
	const to = (p: string) => toRemote(state, p);
	return {
		exists: async (p) => {
			const r = await transport.exec(state.target, `test -e ${shQuote(to(p))}`, state.target.remoteRoot, { timeoutMs: 15_000 });
			return r.exitCode === 0;
		},
		stat: async (p) => {
			const r = await transport.exec(
				state.target,
				`if test -d ${shQuote(to(p))}; then echo dir; else echo file; fi`,
				state.target.remoteRoot,
				{ timeoutMs: 15_000 },
			);
			if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `stat ${to(p)} 失败`);
			const isDirectory = r.stdout.trim() === "dir";
			return { isDirectory: () => isDirectory };
		},
		readdir: async (p) => {
			const r = await transport.exec(state.target, `ls -1 ${shQuote(to(p))}`, state.target.remoteRoot, { timeoutMs: 15_000 });
			if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `ls ${to(p)} 失败`);
			return r.stdout.split("\n").filter(Boolean);
		},
	};
}

export default function (pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const anchor = localAnchor();

	// Local builtin tool instances, used as pass-through when no SSH workspace is active.
	// Local builtin tool definitions (ToolDefinition shape), used as pass-through
	// when no SSH workspace is active.
	const localRead = createReadToolDefinition(cwd);
	const localWrite = createWriteToolDefinition(cwd);
	const localEdit = createEditToolDefinition(cwd);
	const localBash = createBashToolDefinition(cwd);
	const localGrep = createGrepToolDefinition(cwd);
	const localFind = createFindToolDefinition(cwd);
	const localLs = createLsToolDefinition(cwd);
	const localPowershell = createPowerShellToolDefinition(cwd);

	// Explicit local-access tools, active only while an SSH workspace is
	// connected. Registration is additive (new names, no builtin override).
	const LOCAL_TOOLS = ["local_bash", "local_read"] as const;
	let localToolsActivatedByUs = false;
	const activateLocalTools = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || localToolsActivatedByUs) return;
		const active = pi.getActiveTools();
		pi.setActiveTools([...new Set([...active, ...LOCAL_TOOLS])]);
		localToolsActivatedByUs = true;
	};
	const deactivateLocalTools = (ctx: ExtensionContext): void => {
		if (!localToolsActivatedByUs) return;
		if (ctx.hasUI) {
			// Only remove what we added; user-enabled (e.g. via /tools) stay.
			pi.setActiveTools(pi.getActiveTools().filter((name) => !LOCAL_TOOLS.includes(name as (typeof LOCAL_TOOLS)[number])));
		}
		localToolsActivatedByUs = false;
	};

	// Resolve target from env first (background subagent processes), then the CLI flag.
	pi.registerFlag("ssh", { description: "SSH workspace alias from ~/.pi/agent/ssh-workspace.json", type: "string" });

	// The remote target is surfaced as the session name, which pi's TUI renders in
	// the editor header (zentui's minimalist editor puts it in bold green next to
	// the elapsed timer). A name the user set with /name is never overwritten, and
	// a name this extension set is restored on exit.
	let sessionNameApplied: string | undefined;
	let sessionNameBefore: string | undefined;
	function applySessionName(
		ctx: ExtensionContext,
		next: RemoteState | undefined,
		restored?: WorkspaceSessionState,
	): void {
		if (!ctx.hasUI) return; // background subagent processes have no visible session name
		const current = pi.getSessionName();
		if (next) {
			const name = remoteDisplayName(next);
			if (name === current) {
				// On resume the session name is already loaded from session_info. Rebuild
				// the in-memory markers so /ssh exit can restore the user's old name.
				if (sessionNameApplied === undefined && restored?.sessionNameManaged) {
					sessionNameApplied = name;
					sessionNameBefore = restored.sessionNameBefore ?? undefined;
				}
				return;
			}
			if (current && current !== sessionNameApplied) return; // user-named session stays untouched
			if (sessionNameApplied === undefined) {
				sessionNameBefore = restored?.sessionNameManaged ? restored.sessionNameBefore ?? undefined : current;
			}
			sessionNameApplied = name;
			pi.setSessionName(name);
			return;
		}
		if (sessionNameApplied !== undefined && current === sessionNameApplied) {
			pi.setSessionName(sessionNameBefore ?? ""); // an empty name clears the session title
		}
		sessionNameApplied = undefined;
		sessionNameBefore = undefined;
	}

	const persistWorkspaceState = (state: WorkspaceSessionState): void => {
		pi.appendEntry(SESSION_STATE_TYPE, state);
	};
	const currentWorkspaceState = (alias: string): WorkspaceSessionState => ({
		version: 1,
		connected: true,
		alias,
		sessionNameManaged: sessionNameApplied !== undefined,
		sessionNameBefore: sessionNameApplied === undefined ? undefined : sessionNameBefore ?? null,
	});

	const connect = async (
		alias: string,
		ctx: ExtensionContext,
		options: {
			persist?: boolean;
			notify?: boolean;
			restored?: WorkspaceSessionState;
		} = {},
	): Promise<void> => {
		const previous = remote;
		const next = await connectTarget(alias, anchor); // throws without mutating state on failure
		blocked = undefined;
		remote = next;
		applyEnv(next);
		updateStatus(ctx, next);
		applySessionName(ctx, next, options.restored);
		activateLocalTools(ctx);
		if (options.persist) persistWorkspaceState(currentWorkspaceState(next.target.alias));
		if (options.notify !== false && ctx.hasUI) {
			ctx.ui.notify(`已进入 SSH workspace ${next.target.alias}:${next.target.remoteRoot}${previous ? `（原 ${previous.target.alias}）` : ""}`, "info");
		}
	};

	const disconnect = (ctx: ExtensionContext, notify: boolean, persist = true): void => {
		const alias = remote?.target.alias;
		blocked = undefined;
		remote = undefined;
		applyEnv(undefined);
		updateStatus(ctx, undefined);
		applySessionName(ctx, undefined);
		deactivateLocalTools(ctx);
		if (persist) persistWorkspaceState({ version: 1, connected: false });
		if (notify && ctx.hasUI) ctx.ui.notify(`已退出 SSH workspace${alias ? ` ${alias}` : ""}，回到本地`, "info");
	};

	pi.on("session_start", async (_event, ctx) => {
		// Env-derived state wins for background subagent processes. Interactive
		// session state is restored from the current session branch instead.
		const envAlias = process.env[ENV_ALIAS];
		const flagAlias = pi.getFlag("ssh") as string | undefined;
		const savedState = readWorkspaceSessionState(ctx);
		const savedAlias = savedState?.connected ? savedState.alias : undefined;
		// Sessions created before state persistence may still carry the remote target
		// in their display name. Migrate that unambiguous legacy form once.
		const legacyAlias = !envAlias && !flagAlias && !savedState ? legacyAliasForSessionName(pi.getSessionName()) : undefined;
		try {
			if (envAlias) {
				if (!remote || remote.target.alias !== envAlias) {
					const next = await connectTarget(envAlias, localAnchor());
					remote = next;
					blocked = undefined;
					updateStatus(ctx, next);
				}
				applySessionName(ctx, remote);
				activateLocalTools(ctx);
				return;
			}
			if (flagAlias) {
				await connect(flagAlias, ctx, {
					persist: true,
					restored: savedState?.alias === flagAlias ? savedState : undefined,
				});
				return;
			}
			if (savedAlias || legacyAlias) {
				const alias = savedAlias ?? legacyAlias;
				const restored =
					savedState ??
					({
						version: 1,
						connected: true,
						alias,
						sessionNameManaged: true,
						sessionNameBefore: null,
					} satisfies WorkspaceSessionState);
				await connect(alias, ctx, { persist: true, notify: false, restored });
				return;
			}
		} catch (error) {
			// Never fall back to local: a background subagent that thinks it is
			// remote must not silently edit local files. Block all tools instead.
			const reason = (error as Error).message;
			const failedAlias = envAlias ?? flagAlias ?? savedAlias ?? legacyAlias ?? "";
			blocked = { alias: failedAlias, reason };
			if (ctx?.hasUI) {
				ctx.ui.setStatus("ssh-workspace", ctx.ui.theme.fg("error", `● SSH ${blocked.alias} 连接失败`));
				ctx.ui.notify(`SSH workspace ${blocked.alias} 连接失败：${reason}。工具不会回退到本地；用 /ssh ${blocked.alias} 重试或 /ssh exit。`, "warning");
			}
			return;
		}
		remote = undefined;
		blocked = undefined;
		applyEnv(undefined);
		updateStatus(ctx, undefined);
		applySessionName(ctx, undefined);
		deactivateLocalTools(ctx);
	});

	// Session replacement tears down the old extension runtime before binding the
	// new session. Do not append a disconnected state or clear the persisted title:
	// the old session must resume as remote later, while the new session restores
	// its own state from its branch.
	pi.on("session_shutdown", (_event, ctx) => {
		remote = undefined;
		blocked = undefined;
		applyEnv(undefined);
		updateStatus(ctx, undefined);
		deactivateLocalTools(ctx);
		sessionNameApplied = undefined;
		sessionNameBefore = undefined;
	});

	// ---- tool overrides: all 8 builtin names, always registered. ----
	// Local mode delegates to the local builtin implementations; remote mode
	// rebuilds the tool with remote operations against the current state.
	pi.registerTool({
		...localRead,
		execute: (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localRead.execute(id, params, signal, onUpdate, ctx);
			return createReadTool(cwd, { operations: remoteReadOps(s) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localWrite,
		execute: (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localWrite.execute(id, params, signal, onUpdate, ctx);
			return createWriteTool(cwd, { operations: remoteWriteOps(s) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localEdit,
		execute: (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localEdit.execute(id, params, signal, onUpdate, ctx);
			return createEditTool(cwd, { operations: remoteEditOps(s) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localBash,
		execute: (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localBash.execute(id, params, signal, onUpdate, ctx);
			return createBashTool(cwd, { operations: remoteBashOps(s) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localFind,
		execute: (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localFind.execute(id, params, signal, onUpdate, ctx);
			return createFindTool(cwd, { operations: remoteFindOps(s) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localLs,
		execute: (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localLs.execute(id, params, signal, onUpdate, ctx);
			return createLsTool(cwd, { operations: remoteLsOps(s) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localPowershell,
		execute: (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localPowershell.execute(id, params, signal, onUpdate, ctx);
			throw new Error("powershell 工具在 SSH 远端（Unix workspace）下不可用；请用 bash 工具");
		},
	});

	// ---- explicit local-access tools (additive, activated only in remote mode) ----
	pi.registerTool({
		...localBash,
		name: "local_bash",
		label: "Local Bash",
		description:
			"Execute a command on the LOCAL machine (not the SSH workspace). Use this only when you explicitly need local access while an SSH workspace is active.",
		promptGuidelines: [
			"When an SSH workspace is active, read/write/edit/bash/grep/find/ls operate on the REMOTE machine; use local_bash to run commands on the local machine instead.",
		],
		execute: (id, params, signal, onUpdate, ctx) => localBash.execute(id, params, signal, onUpdate, ctx),
	});
	pi.registerTool({
		...localRead,
		name: "local_read",
		label: "Local Read",
		description:
			"Read a file on the LOCAL machine (not the SSH workspace). Use this only when you explicitly need local access while an SSH workspace is active.",
		promptGuidelines: [
			"SSH workspace 激活时，read/bash/edit/write/grep/find/ls 作用于远端；需要读本地文件时用 local_read。",
		],
		execute: (id, params, signal, onUpdate, ctx) => localRead.execute(id, params, signal, onUpdate, ctx),
	});

	// Remote grep: run rg on the remote host. pi's builtin grep executes ripgrep
	// locally, so we cannot reuse its tool shell and instead reimplement the
	// narrow rg invocation the builtin performs.
	pi.registerTool({
		...localGrep,
		execute: async (id, params, signal, onUpdate, ctx) => {
			const s = resolveState();
			if (!s) return localGrep.execute(id, params, signal, onUpdate, ctx);
			const pattern = String((params as { pattern: string }).pattern);
			const pathParam = (params as { path?: string }).path;
			const globParam = (params as { glob?: string }).glob;
			const ignoreCase = Boolean((params as { ignoreCase?: boolean }).ignoreCase);
			const literal = Boolean((params as { literal?: boolean }).literal);
			const context = (params as { context?: number }).context;
			const limit = (params as { limit?: number }).limit ?? 50;
			const searchRoot = toRemote(s, pathParam ? (pathParam.startsWith("/") ? pathParam : `${cwd}/${pathParam}`) : cwd);
			// Run from the search root with "." so output paths are relative,
			// matching the builtin grep's path:line:content / path-line- format.
			const args = [
				"rg",
				"--line-number",
				"--color", "never",
				...(ignoreCase ? ["--ignore-case"] : []),
				...(literal ? ["--fixed-strings"] : []),
				...(context ? ["--context", String(context)] : []),
				...(globParam ? ["--glob", shQuote(globParam)] : []),
				shQuote(pattern),
				".",
			];
			// rg's -m is per-file while the builtin's limit is a global cap, so
			// approximate with a total-line cap (documented in README).
			const maxLines = Math.min(2000, Math.max(limit, 200));
			const result = await transport.exec(s.target, `${args.join(" ")} | head -n ${maxLines}`, searchRoot, { timeoutMs: 60_000, signal });
			if (result.exitCode !== 0 && result.exitCode !== 1 && result.stdout.length === 0) {
				throw new Error(result.stderr.trim() || `rg 失败 (${result.exitCode})`);
			}
			const text = result.stdout.replace(/^\.\//gm, "").trimEnd();
			return {
				content: [{ type: "text", text: text || "无匹配" }],
				details: { truncation: undefined },
			};
		},
	});

	// ---- user ! / !! commands ----
	pi.on("user_bash", (_event, ctx) => {
		const s = resolveState();
		if (!s) return;
		return {
			operations: remoteBashOps(s),
		};
	});

	// ---- system prompt: line-based rewrite with a guaranteed fallback ----
	pi.on("before_agent_start", (event) => {
		const s = remote;
		if (!s) return; // local or blocked: tools throw on blocked, prompt stays as-is
		const remoteLine = [
			`Current working directory: ${s.target.remoteRoot} (SSH: ${s.target.alias}) — 本地文件系统不可用，所有文件操作都在远端 workspace`,
			`本地 anchor 目录（本机）: ${s.anchor}`,
			`subagent 工具的 cwd 参数作用于本地机器：请传本地 anchor 路径（${s.anchor}）或省略；子代理内部的文件工具会自动跟随当前 SSH workspace。workflowScript 中不要给步骤设置 cwd。`,
		].join("\n");
		const linePattern = /^Current working directory: .*$/m;
		if (linePattern.test(event.systemPrompt)) {
			return { systemPrompt: event.systemPrompt.replace(linePattern, remoteLine) };
		}
		// Fallback: never leave the model unaware of the remote workspace.
		return { systemPrompt: event.systemPrompt + "\n\n" + remoteLine };
	});

	// ---- subagent guard (remote mode only) ----
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		const s = remote;
		const b = blocked;
		if (!s && b) {
			return {
				block: true,
				reason: `SSH workspace 不可用（${b.reason}），子代理不会在本地文件系统运行。请修复连接后重试，或 /ssh exit。`,
			};
		}
		if (!s) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (input.worktree === true || input.isolation === "worktree") {
			return {
				block: true,
				reason: `SSH 远端工作区不支持 worktree 隔离（worktree 是本地 git 操作）。请使用 worktree=false/isolation=none。`,
			};
		}
		if (input.async === false) {
			return {
				block: true,
				reason: `SSH 远端工作区下前台子代理会在本地文件系统运行（pi-subagents 机制限制）。请使用 async: true 的后台子代理。`,
			};
		}
		// Normalize a remote cwd to its local counterpart: pi-subagents validates
		// cwd on the local filesystem, so a remote path would abort the launch.
		if (typeof input.cwd === "string" && input.cwd.length > 0) {
			const remoteRoot = s.target.remoteRoot;
			const anchor = s.anchor;
			let localCounterpart: string | undefined;
			if (input.cwd === remoteRoot) {
				localCounterpart = anchor;
			} else if (input.cwd.startsWith(remoteRoot + "/")) {
				localCounterpart = anchor + input.cwd.slice(remoteRoot.length);
			}
			if (localCounterpart !== undefined) {
				let rewritten = localCounterpart;
				try {
					if (!statSync(localCounterpart).isDirectory()) rewritten = anchor;
				} catch {
					rewritten = anchor;
				}
				if (rewritten !== input.cwd) {
					const original = input.cwd;
					input.cwd = rewritten;
					if (ctx?.hasUI) {
						ctx.ui.notify(`子代理 cwd 已从远端路径 ${original} 改写为本地路径 ${rewritten}（子代理工具会自动跟随 SSH workspace）`, "info");
					}
				}
			}
			// Not a remote path: leave it alone; local-path errors surface from pi-subagents.
		}
	});

	// ---- /ssh commands ----
	pi.registerCommand("ssh", {
		description: "SSH workspace：/ssh 列表 | /ssh <alias> | /ssh exit | /ssh status | /ssh reload | /ssh forget",
		handler: async (argument, ctx) => {
			const arg = argument.trim();
			if (!arg) {
				const config = loadConfig();
				const names = Object.keys(config.aliases).sort((a, b) => {
					if (a === config.defaultAlias) return -1;
					if (b === config.defaultAlias) return 1;
					return a.localeCompare(b);
				});
				if (names.length === 0) {
					ctx.ui.notify("~/.pi/agent/ssh-workspace.json 里没有配置任何别名", "warning");
					return;
				}
				const labels = names.map((name) => {
					const entry = config.aliases[name];
					const current = remote?.target.alias === name ? "（当前）" : "";
					const isDefault = name === config.defaultAlias ? "（默认）" : "";
					return `${name} — ${entry.host}${entry.port ? `:${entry.port}` : ""}${entry.path ? ` ${entry.path}` : ""} ${entry.description ?? ""} ${isDefault}${current}`.trim();
				});
				const picked = await ctx.ui.select("选择 SSH workspace", labels);
				if (!picked) return;
				const alias = picked.slice(0, picked.indexOf("—")).trim();
				await connect(alias, ctx, { persist: true });
				return;
			}
			if (arg === "exit" || arg === "forget") {
				disconnect(ctx, true);
				return;
			}
			if (arg === "status") {
				if (blocked) {
					ctx.ui.notify(`SSH workspace ${blocked.alias} 连接失败：${blocked.reason}（工具已封锁，不会回退本地）`, "warning");
					return;
				}
				if (!remote) {
					ctx.ui.notify("当前是本地模式（未连接 SSH workspace）", "info");
					return;
				}
				ctx.ui.notify(`SSH workspace: ${remote.target.alias} (${remote.target.host}${remote.target.port ? `:${remote.target.port}` : ""}) 远端根目录: ${remote.target.remoteRoot}`, "info");
				return;
			}
			if (arg === "reload") {
				loadConfig(); // validates; errors propagate to the UI
				ctx.ui.notify("配置已重读", "info");
				return;
			}
			await connect(arg, ctx, { persist: true });
		},
	});
}
