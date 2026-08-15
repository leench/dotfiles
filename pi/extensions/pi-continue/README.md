# pi-continue

Resume interrupted agent tasks in pi. When the LLM API fails, the network drops, or you hit Esc mid-task, the agent stops with its work half done. Type `/continue` (or `/c`) to tell it to pick up where it left off.

## Install

```bash
# Global install (~/.pi/agent/extensions/)
mkdir -p ~/.pi/agent/extensions/pi-continue
cd ~/.pi/agent/extensions/pi-continue
# copy this package's files (index.ts, package.json) here
npm install
```

Then run `/reload` in pi, or restart — `/continue` and `/c` become available.

## Usage

```
/continue             Resume the interrupted task
/c                    Shorthand for /continue
/continue <extra>     Resume with an additional note (e.g. /continue 换一种方式实现)
```

What it does:

1. Finds the most recent user message (the task) on the current branch
2. Sends an instruction telling the agent to check its current progress and continue from where it stopped — without restarting
3. The agent resumes with its full existing context (tool results, file states, partial work)

## Notes

- Works regardless of *why* the agent stopped: API errors, timeouts, manual interrupts
- The task text is attached to the instruction so the agent stays focused even after context compaction
- No state is tracked — the command is always safe to run
