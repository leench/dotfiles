import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal SSH transport built on the system `ssh` client.
 * Key/agent auth only — no password or interactive authentication.
 */

export interface SshTarget {
	alias: string;
	host: string;
	port?: number;
	remoteRoot: string;
}

/** Single-quote a value for POSIX shell consumption (never JSON.stringify: $ and backticks). */
export function shQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

export class SshConnectionError extends Error {}

/** Thrown when the command was killed because our timeoutMs elapsed. */
export class SshTimeoutError extends Error {}

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export class SshTransport {
	private controlDir: string | undefined;

	/**
	 * Long-lived master connection so each tool call does not pay a fresh handshake.
	 * Kept in the OS temp dir keyed by the alias to avoid path collisions.
	 */
	private controlPathFor(alias: string): string {
		if (!this.controlDir) {
			this.controlDir = mkdtempSync(join(tmpdir(), "pi-ssh-ws-"));
		}
		return join(this.controlDir, encodeURIComponent(alias));
	}

	private buildArgs(target: SshTarget, remoteCommand: string): string[] {
		const args = [
			"-o", "ControlMaster=auto",
			"-o", `ControlPath=${this.controlPathFor(target.alias)}`,
			"-o", "ControlPersist=10m",
			"-o", "BatchMode=yes",
			// Drop client warnings such as the post-quantum KEX notice; they are
			// streamed into tool output and would be shown to the model.
			"-o", "LogLevel=ERROR",
			"-T",
			"-o", "ConnectTimeout=10",
		];
		if (target.port !== undefined) {
			args.push("-p", String(target.port));
		}
		args.push(target.host, remoteCommand);
		return args;
	}

	/**
	 * Run a remote command, returning raw stdout bytes (binary safe: images,
	 * non-UTF-8 files). Rejects with SshTimeoutError when timeoutMs elapsed and
	 * with SshConnectionError when the transport itself fails (exit code 255).
	 */
	runRaw(target: SshTarget, remoteCommand: string, options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		onData?: (data: Buffer) => void;
		stdin?: Buffer;
	} = {}): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }> {
		return new Promise((resolve, reject) => {
			// Own process group so a timed-out/aborted kill also reaps local
			// descendants (grandchildren keep stdio pipes open otherwise, delaying
			// the close event and therefore the error).
			const child = spawn("ssh", this.buildArgs(target, remoteCommand), {
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let settled = false;

			let timedOut = false;
			const killTree = () => {
				try {
					if (child.pid) process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			};
			const timer = options.timeoutMs
				? setTimeout(() => {
						timedOut = true;
						killTree();
					}, options.timeoutMs)
				: undefined;
			const onAbort = () => killTree();
			options.signal?.addEventListener("abort", onAbort, { once: true });

			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				reject(error);
			};
			child.on("error", (error) => fail(new SshConnectionError(`ssh 启动失败: ${error.message}`)));
			child.stderr.on("data", (data: Buffer) => stderr.push(data));
			child.stdout.on("data", (data: Buffer) => {
				options.onData?.(data);
				stdout.push(data);
			});
			if (options.stdin) child.stdin.end(options.stdin);
			else child.stdin.end();

			child.on("close", (exitCode) => {
				if (settled) return;
				// fail() checks `settled` before rejecting, so only set it on the resolve path.
				if (timedOut) return fail(new SshTimeoutError("timeout"));
				if (exitCode === 255) {
					// 255 is ssh's own transport/auth failure code
					return fail(new SshConnectionError(Buffer.concat(stderr).toString("utf-8").trim() || "SSH 连接失败"));
				}
				settled = true;
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
			});
		});
	}

	/** Run a remote command, decoding stdout/stderr as UTF-8 text. */
	async run(target: SshTarget, remoteCommand: string, options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		onData?: (data: Buffer) => void;
		stdin?: Buffer;
	} = {}): Promise<ExecResult> {
		const raw = await this.runRaw(target, remoteCommand, options);
		return { stdout: raw.stdout.toString("utf-8"), stderr: raw.stderr.toString("utf-8"), exitCode: raw.exitCode };
	}

	async check(target: SshTarget): Promise<void> {
		const result = await this.run(target, "true");
		if (result.exitCode !== 0) {
			throw new SshConnectionError(result.stderr.trim() || `ssh exited with ${result.exitCode}`);
		}
	}

	async resolveRemoteRoot(target: SshTarget): Promise<string> {
		const result = await this.run(target, "pwd");
		if (result.exitCode !== 0) {
			throw new SshConnectionError(result.stderr.trim() || `pwd failed with ${result.exitCode}`);
		}
		return result.stdout.trim().split("\n").pop() ?? "/";
	}

	/** Run a command with cwd semantics, like a local shell would. */
	async exec(target: SshTarget, command: string, cwd: string, options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		onData?: (data: Buffer) => void;
	} = {}): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
		// cd guards against a stale ControlMaster sharing a different cwd; `|| exit 1` keeps cd failures visible.
		const remote = `cd ${shQuote(cwd)} || exit 1\n${command}`;
		// stdin closed so interactive prompts fail fast rather than hang.
		const result = await this.run(target, remote, {
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			onData: options.onData,
			stdin: Buffer.alloc(0),
		});
		return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
	}

	/** Read a remote file as raw bytes (binary safe — no UTF-8 round trip). */
	async readFile(target: SshTarget, remotePath: string): Promise<Buffer> {
		const raw = await this.runRaw(target, `cat ${shQuote(remotePath)}`, { stdin: Buffer.alloc(0) });
		if (raw.exitCode !== 0) {
			throw new Error(raw.stderr.toString("utf-8").trim() || `cat exited with ${raw.exitCode}`);
		}
		return raw.stdout;
	}

	/** Write a remote file: raw bytes on stdin piped through `cat > <path>`. */
	async writeFile(target: SshTarget, remotePath: string, content: string): Promise<void> {
		const raw = await this.runRaw(target, `cat > ${shQuote(remotePath)}`, {
			stdin: Buffer.from(content, "utf-8"),
		});
		if (raw.exitCode !== 0) {
			throw new Error(raw.stderr.toString("utf-8").trim() || `write failed with ${raw.exitCode}`);
		}
	}
}
