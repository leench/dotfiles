import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";

// These are the persisted state markers used by pi-ssh-remote. The bridge only
// reads them; it does not import private implementation modules from the
// third-party extension.
const SSH_REMOTE_STATE_TYPE = "pi-ssh-remote-state";
const SSH_LOCAL_STATE_TYPE = "pi-ssh-local-state";

// Public event/message identifiers from pi-ssh-remote. Keep these as strings
// so the local bridge does not import or patch the third-party extension.
const SSH_ENVIRONMENT_EVENT = "ssh-remote:environment";
const SSH_ENVIRONMENT_CONTEXT_TYPE = "ssh-remote-environment";

interface RemoteSessionState {
  target: string;
  remoteCwd: string;
}

type RecordLike = Record<string, unknown>;

type SubagentInput = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function isSshEnvironmentContextMessage(value: unknown): boolean {
  const message = asRecord(value);
  return message?.role === "custom"
    && message.customType === SSH_ENVIRONMENT_CONTEXT_TYPE;
}

function sshContextMessageKey(value: unknown): string {
  const message = asRecord(value);
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return JSON.stringify(message.content) ?? "";
}

function findRemoteSessionState(ctx: ExtensionContext): RemoteSessionState | undefined {
  const branch = ctx.sessionManager.getBranch() as unknown[];

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(branch[index]);
    if (!entry || entry.type !== "custom") continue;

    // A later local marker supersedes all earlier remote markers on this
    // branch, matching pi-ssh-remote's environment-state semantics.
    if (entry.customType === SSH_LOCAL_STATE_TYPE) return undefined;
    if (entry.customType !== SSH_REMOTE_STATE_TYPE) continue;

    const data = asRecord(entry.data);
    if (
      data
      && typeof data.target === "string"
      && data.target.length > 0
      && typeof data.remoteCwd === "string"
      && data.remoteCwd.length > 0
    ) {
      return {
        target: data.target,
        remoteCwd: data.remoteCwd,
      };
    }
  }

  return undefined;
}

function isLocalDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function notify(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

function blockReason(remote: RemoteSessionState, detail: string): string {
  return [
    "SSH subagent bridge blocked the child launch.",
    `Remote workspace: ${remote.target}:${remote.remoteCwd}`,
    detail,
  ].join(" ");
}

export default function (pi: ExtensionAPI): void {
  let lastForwardedSshContextKey: string | undefined;
  const resetSshContextDeduplication = (): void => {
    lastForwardedSshContextKey = undefined;
  };

  // pi-ssh-remote emits this when the active SSH environment is connected,
  // exited, or its remote cwd changes. The next context message must be shown
  // to the model even if its text happens to match the previous environment.
  pi.events.on(SSH_ENVIRONMENT_EVENT, resetSshContextDeduplication);
  pi.on("session_start", resetSshContextDeduplication);

  // pi-ssh-remote injects this hidden custom message before every provider
  // request. Keep it on the first request and when its semantic content or SSH
  // state changes; suppress identical repeats that make the model acknowledge
  // the same remote workspace over and over.
  pi.on("context", (event) => {
    const sshContextMessage = [...event.messages]
      .reverse()
      .find(isSshEnvironmentContextMessage);
    const messagesWithoutSshContext = event.messages.filter(
      (message) => !isSshEnvironmentContextMessage(message),
    );

    if (!sshContextMessage) {
      resetSshContextDeduplication();
      return messagesWithoutSshContext.length === event.messages.length
        ? undefined
        : { messages: messagesWithoutSshContext };
    }

    const contextKey = sshContextMessageKey(sshContextMessage);
    if (contextKey === lastForwardedSshContextKey) {
      return { messages: messagesWithoutSshContext };
    }

    lastForwardedSshContextKey = contextKey;
    return {
      messages: [...messagesWithoutSshContext, sshContextMessage],
    };
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;

    const remote = findRemoteSessionState(ctx);
    if (!remote) return;

    const input = asRecord(event.input) as SubagentInput | undefined;
    if (!input) {
      return {
        block: true,
        reason: blockReason(remote, "The subagent arguments are not an object."),
      };
    }

    const localAnchor = ctx.cwd;

    if (!isLocalDirectory(localAnchor)) {
      return {
        block: true,
        reason: blockReason(
          remote,
          `The local session anchor is not a directory: ${localAnchor}`,
        ),
      };
    }

    const sessionFile = ctx.sessionManager.getSessionFile();
    const leafId = ctx.sessionManager.getLeafId();
    if (!sessionFile || !leafId) {
      return {
        block: true,
        reason: blockReason(
          remote,
          "A persisted parent session is required; restart Pi without --no-session.",
        ),
      };
    }

    // A fresh child cannot inherit pi-ssh-remote's session state. Normalize
    // the model's explicit fresh preference instead of spending a turn on a
    // preventable failed launch; this keeps the child in the remote workspace.
    if (input.context === "fresh") input.context = "fork";

    // `profile` may resolve to a fresh context depending on the selected
    // agent. An SSH child must be forked so the persisted remote state follows
    // it deterministically.
    if (input.context === undefined || input.context === "profile") {
      input.context = "fork";
    }

    const requestedCwd = input.cwd;
    if (
      typeof requestedCwd !== "string"
      || requestedCwd.length === 0
      || !isLocalDirectory(requestedCwd)
    ) {
      input.cwd = localAnchor;
      if (typeof requestedCwd === "string" && requestedCwd.length > 0) {
        notify(
          ctx,
          `SSH subagent bridge mapped non-local cwd ${requestedCwd} to ${localAnchor}`,
        );
      }
    }

    if (input.worktree === true || input.isolation === "worktree") {
      return {
        block: true,
        reason: blockReason(
          remote,
          "worktree isolation is local-only and unsafe for a remote workspace; use worktree=false/isolation=none.",
        ),
      };
    }

    // Make the intended remote-safe default explicit for direct subagent calls
    // and workflow launches. Explicit worktree=true is rejected above.
    if (input.worktree === undefined) input.worktree = false;

    // An explicit extensions allowlist disables ambient extensions. Do not
    // silently broaden it; the user must include pi-ssh-remote themselves.
    if (Array.isArray(input.extensions)) {
      const includesSshExtension = input.extensions.some(
        (extension) =>
          typeof extension === "string"
          && (
            extension.includes("pi-ssh-remote")
            || extension.endsWith("@99percentpeople/pi-ssh-remote/index.min.js")
          ),
      );
      if (!includesSshExtension) {
        return {
          block: true,
          reason: blockReason(
            remote,
            "The child has an explicit extensions allowlist without pi-ssh-remote; remove it or include the SSH extension.",
          ),
        };
      }
    }
  });
}
