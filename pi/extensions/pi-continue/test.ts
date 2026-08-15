// Smoke test for pi-continue: message construction + idle guard.
// Run: node --experimental-strip-types --no-warnings test.ts
import extension from "./index.ts";

const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(
			`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	} else {
		console.log(`✓ ${name}`);
	}
}

const sent: string[] = [];
const notifications: string[] = [];
let idle = true;
const ctx = {
	isIdle: () => idle,
	ui: { notify: (msg: string) => void notifications.push(msg) },
};
const registered: Array<{
	name: string;
	handler: (a: string, c: unknown) => Promise<void>;
}> = [];
const pi = {
	sendUserMessage: async (msg: string) => {
		sent.push(msg);
	},
	registerCommand: (
		name: string,
		opts: { handler: (a: string, c: unknown) => Promise<void> },
	) => {
		registered.push({ name, handler: opts.handler });
	},
};

extension(pi as never);

check(
	"注册了 continue 和 c",
	registered.map((r) => r.name),
	["continue", "c"],
);

// --- idle + no args ---
await registered[0].handler("", ctx as never);
check("无参数消息", sent, ["继续执行刚才被中断的任务。"]);

// --- idle + args ---
await registered[0].handler("改用方案 B", ctx as never);
check("带补充说明", sent, [
	"继续执行刚才被中断的任务。",
	"继续执行刚才被中断的任务。\n\n补充说明：改用方案 B",
]);

// --- not idle: no message sent, only a warning ---
idle = false;
const before = notifications.length;
await registered[0].handler("", ctx as never);
check("非 idle 不发送消息", sent.length, 2);
check("非 idle 发送警告", notifications.length - before, 1);

if (failures.length > 0) {
	console.error("\nFAILED:\n" + failures.join("\n"));
	process.exit(1);
}
console.log("\nAll tests passed");
