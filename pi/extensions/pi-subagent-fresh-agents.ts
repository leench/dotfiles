import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type AgentDiscoveryModule = {
  clearAgentDiscoveryCache?: unknown;
};

type RecordLike = Record<string, unknown>;

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SCHEDULE_LAUNCH_ACTIONS = new Set([
  "schedule.run",
  "schedule.run-due",
  "project.open",
]);

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function isFreshLaunch(value: unknown): boolean {
  const input = asRecord(value);
  if (!input) return false;

  if (typeof input.action === "string") {
    return SCHEDULE_LAUNCH_ACTIONS.has(input.action);
  }

  return typeof input.agent === "string"
    || Array.isArray(input.tasks)
    || Array.isArray(input.chain)
    || typeof input.workflow === "string"
    || typeof input.workflowScript === "string"
    || typeof input.workflowScriptPath === "string";
}

async function loadCacheInvalidator(): Promise<(() => void) | undefined> {
  const agentDir = getAgentDir();
  const modulePaths = [
    join(agentDir, "npm", "node_modules", "pi-subagents", "src", "agents", "agents.js"),
    join(agentDir, "node_modules", "pi-subagents", "src", "agents", "agents.js"),
  ];
  const modulePath = modulePaths.find(existsSync);

  if (!modulePath) {
    throw new Error(`Could not find pi-subagents agent discovery module under ${agentDir}`);
  }

  // pi-subagents does not expose cache invalidation publicly. Import its own
  // module by its installed file path so this reaches the same process-local cache.
  const agentModule = await import(pathToFileURL(modulePath).href) as AgentDiscoveryModule;
  if (typeof agentModule.clearAgentDiscoveryCache !== "function") {
    throw new Error("pi-subagents no longer exports clearAgentDiscoveryCache from its agent discovery module");
  }

  return agentModule.clearAgentDiscoveryCache as () => void;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  let clearCache: (() => void) | undefined;

  try {
    clearCache = await loadCacheInvalidator();
  } catch (error) {
    console.warn(
      "[pi-subagent-fresh-agents] Could not connect to pi-subagents cache invalidation; "
        + "its normal file-fingerprint refresh remains active.",
      error,
    );
  }

  const refreshBeforeLaunch = (params: unknown): void => {
    if (!clearCache || !isFreshLaunch(params)) return;
    clearCache();
  };

  pi.on("tool_call", (event) => {
    if (event.toolName === "subagent") refreshBeforeLaunch(event.input);
  });

  // /run reaches the executor over this event rather than through tool_call.
  pi.events.on(SLASH_SUBAGENT_REQUEST_EVENT, (request) => {
    refreshBeforeLaunch(asRecord(request)?.params);
  });
}
