/**
 * pi-continue: resume interrupted agent tasks.
 *
 * After an LLM API failure, network error, or manual interrupt (Esc),
 * type /continue (or /c) to tell the agent to pick up where it left off.
 *
 * The agent already has the full session context (task, progress, prior
 * output), so the injected message is intentionally minimal — equivalent
 * to typing "继续" by hand, plus an optional inline supplement.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent 正在运行中，无需继续。", "warning");
			return;
		}

		const extra = args.trim();
		const msg = extra
			? `继续执行刚才被中断的任务。\n\n补充说明：${extra}`
			: "继续执行刚才被中断的任务。";

		await pi.sendUserMessage(msg);
		ctx.ui.notify("已发送继续指令，agent 将接着上次中断的位置继续。", "info");
	};

	pi.registerCommand("continue", {
		description: "继续执行被中断的任务（LLM API 故障或手动中断后使用）",
		handler,
	});

	pi.registerCommand("c", {
		description: "继续执行被中断的任务（/continue 的简写）",
		handler,
	});
}
