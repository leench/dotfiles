import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SshTargetConfig {
	host: string;
	port?: number;
	path?: string;
	description?: string;
}

export interface SshWorkspaceConfig {
	defaultAlias?: string;
	aliases: Record<string, SshTargetConfig>;
}

export function configPath(): string {
	return join(getAgentDir(), "ssh-workspace.json");
}

export function loadConfig(): SshWorkspaceConfig {
	const file = configPath();
	if (!existsSync(file)) {
		throw new Error(`配置文件不存在: ${file}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf-8"));
	} catch (error) {
		throw new Error(`配置文件不是合法 JSON: ${file} (${(error as Error).message})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`配置文件格式错误: ${file} 顶层必须是对象`);
	}
	const record = parsed as Record<string, unknown>;
	const rawAliases = record.aliases;
	if (typeof rawAliases !== "object" || rawAliases === null || Array.isArray(rawAliases)) {
		throw new Error(`配置文件格式错误: ${file} 缺少 aliases 对象`);
	}
	const aliases: Record<string, SshTargetConfig> = {};
	for (const [name, value] of Object.entries(rawAliases as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) {
			throw new Error(`配置文件格式错误: 别名 ${name} 必须是对象`);
		}
		const entry = value as Record<string, unknown>;
		if (typeof entry.host !== "string" || entry.host.length === 0) {
			throw new Error(`配置文件格式错误: 别名 ${name} 缺少 host`);
		}
		if (entry.port !== undefined && (typeof entry.port !== "number" || !Number.isInteger(entry.port))) {
			throw new Error(`配置文件格式错误: 别名 ${name} 的 port 必须是整数`);
		}
		if (entry.path !== undefined && typeof entry.path !== "string") {
			throw new Error(`配置文件格式错误: 别名 ${name} 的 path 必须是字符串`);
		}
		aliases[name] = {
			host: entry.host,
			port: entry.port as number | undefined,
			path: entry.path as string | undefined,
			description: typeof entry.description === "string" ? entry.description : undefined,
		};
	}
	const defaultAlias = typeof record.defaultAlias === "string" ? record.defaultAlias : undefined;
	if (defaultAlias !== undefined && !(defaultAlias in aliases)) {
		throw new Error(`配置文件格式错误: defaultAlias "${defaultAlias}" 不在 aliases 里`);
	}
	return { defaultAlias, aliases };
}
