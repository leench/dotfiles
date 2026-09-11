import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Main-agent output token speed.
 *
 * Tracks provider usage on assistant messages (message_start / message_update /
 * message_end) and shows the latest output tokens/second in the persistent
 * extension status line of the footer. Deliberately independent from the
 * subagent TUI widget, which only exists while subagents are running.
 *
 * Speed definition: output tokens (usage.output, includes reasoning tokens)
 * divided by the wall-clock duration of the current assistant message.
 * Provider streaming usage is usually unavailable mid-stream, so the live value
 * is only shown when the provider reports partial usage; otherwise the precise
 * per-message speed appears in the status line once message_end delivers the
 * final usage and stays there until the next assistant message.
 */

const STATUS_ID = "agent-token-speed";

type MessageLike = {
	role?: unknown;
	usage?: unknown;
};

function outputTokens(usage: unknown): number {
	if (typeof usage !== "object" || usage === null) return 0;
	const output = (usage as { output?: unknown }).output;
	return typeof output === "number" && Number.isFinite(output) && output > 0
		? output
		: 0;
}

function speedText(tokens: number, elapsedMs: number): string | undefined {
	if (tokens <= 0 || elapsedMs <= 0) return undefined;
	const speed = tokens / (elapsedMs / 1000);
	if (!Number.isFinite(speed) || speed <= 0) return undefined;
	const rounded = speed >= 10 ? Math.round(speed) : Math.round(speed * 10) / 10;
	return `main ${rounded} tok/s`;
}

export default function agentTokenSpeed(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	let startedAt: number | undefined;
	let lastText: string | undefined;

	function setStatus(text: string | undefined): void {
		if (text === lastText) return;
		lastText = text;
		try {
			currentCtx?.ui.setStatus(STATUS_ID, text);
		} catch {
			// Session replacement can invalidate the old UI context.
		}
	}

	pi.on("message_start", (event) => {
		const message = event.message as MessageLike | undefined;
		if (message?.role !== "assistant") return;
		startedAt = Date.now();
	});

	pi.on("message_update", (event) => {
		if (startedAt === undefined) return;
		const partial = (event.assistantMessageEvent as
			| { partial?: MessageLike }
			| undefined)?.partial;
		const tokens = outputTokens(partial?.usage);
		if (tokens <= 0) return; // Provider streams no usage yet; wait for message_end.
		const text = speedText(tokens, Date.now() - startedAt);
		if (text) setStatus(text);
	});

	pi.on("message_end", (event) => {
		const message = event.message as MessageLike | undefined;
		if (message?.role !== "assistant") return;
		const tokens = outputTokens(message.usage);
		const elapsed = startedAt !== undefined ? Date.now() - startedAt : 0;
		startedAt = undefined;
		const text = speedText(tokens, elapsed);
		// Precise per-message speed; stays visible until the next assistant message.
		if (text) setStatus(text);
	});

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		startedAt = undefined;
		lastText = undefined;
		if (ctx.hasUI && ctx.mode === "tui") {
			try {
				ctx.ui.setStatus(STATUS_ID, undefined);
			} catch {
				// Best effort.
			}
		}
	});

	pi.on("session_shutdown", () => {
		try {
			currentCtx?.ui.setStatus(STATUS_ID, undefined);
		} catch {
			// Best effort during shutdown.
		}
		currentCtx = undefined;
		startedAt = undefined;
		lastText = undefined;
	});
}
