/**
 * stray-output-guard — 临时扩展：拦住绕过 pi TUI 的裸输出，避免污染输入框区域。
 *
 * 背景：
 * - Node 的进程警告（例如 node:sqlite 的 ExperimentalWarning）和扩展里的
 *   console.warn / console.error / process.stderr.write 都会写到进程 stderr；
 *   pi 的 TUI 不接管自身 stderr，这些裸文本就留在输入框所在的屏幕区域。
 * - 实测：Node 内部警告不经过 process.stderr.write 的 JS 层，必须改 process.emitWarning；
 *   console.warn / console.error 与直接 process.stderr.write 会被补丁捕获。
 *
 * 行为：
 * - 只在 stdout 是 TTY（交互式 TUI）时生效，非交互模式（-p / rpc）完全不改动。
 * - stderr 与进程警告在扩展加载时刻就接管（pi 的界面本来就只从 stdout 绘制，stderr
 *   在交互模式下没有需要展示的内容）；console.log 一类 stdout 通道等到 session_start
 *   （界面起来）再接管，避免吞掉 pi 自身的启动信息。
 * - 被拦下的内容追加到 ~/.pi/agent/stray-output.log。
 * 已知不覆盖：第三方直接写 process.stdout.write（pi 的 TUI 自己也用 stdout，不能接管）。
 *
 * 回滚：删除 ~/.pi/agent/extensions/stray-output-guard.ts 这个 symlink 即可。
 */

import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG_PATH = `${process.env.HOME ?? "/tmp"}/.pi/agent/stray-output.log`;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const INSTALLED_KEY = "__piStrayOutputGuardInstalled";

function append(kind: string, text: string): void {
	const body = text.replace(/\s+$/, "");
	if (body.length === 0) return;
	try {
		if ((statSync(LOG_PATH, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
			writeFileSync(LOG_PATH, "");
		}
		appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${kind} ${body}\n`);
	} catch {
		// 写日志失败绝不能影响会话。
	}
}

function stringify(value: unknown): string {
	return typeof value === "string" ? value : inspect(value);
}

function installOnce(): boolean {
	const flag = globalThis as { [INSTALLED_KEY]?: boolean };
	if (flag[INSTALLED_KEY] === true) return false;
	flag[INSTALLED_KEY] = true;
	return true;
}

// 扩展加载时就接管 stderr 与进程警告：启动阶段也可能冒出 sqlite 之类的实验性警告。
function installStreamGuard(): void {
	if (!installOnce()) return;

	// 1) Node 进程警告：默认处理器自己写 stderr，不经过 process.stderr.write。
	process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
		const message = typeof warning === "string" ? warning : warning.message;
		const first = rest[0];
		const type =
			typeof first === "string"
				? first
				: typeof first === "object" && first !== null && "type" in first
					? String((first as { type?: unknown }).type)
					: undefined;
		append(type === undefined ? "[warning]" : `[warning ${type}]`, message);
	}) as typeof process.emitWarning;

	// 2) 直接写 stderr 的内容：console.warn / console.error / process.stderr.write。
	process.stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
		append("[stderr]", Buffer.isBuffer(chunk) ? chunk.toString("utf8") : stringify(chunk));
		if (typeof encoding === "function") (encoding as () => void)();
		else if (typeof callback === "function") (callback as () => void)();
		return true;
	}) as typeof process.stderr.write;
}

// 界面起来之后再接管 console 的 stdout 通道：这些输出同样会被 TUI 重绘打乱。
function installConsoleGuard(): void {
	for (const method of ["log", "info", "debug", "trace"] as const) {
		console[method] = (...args: unknown[]): void => {
			append(`[console.${method}]`, args.map(stringify).join(" "));
		};
	}
}

export default function (pi: ExtensionAPI): void {
	if (!process.stdout.isTTY) return;
	append("[boot]", `stray-output-guard loaded (pid ${process.pid})`);
	installStreamGuard();
	pi.on("session_start", () => installConsoleGuard());
}
