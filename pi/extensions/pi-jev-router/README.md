# pi-jev-router

Jev task-routing and delegation for Pi. The extension uses Pi's model registry and existing OpenCode authentication to call OpenCode Zen System One with `jev-1.13-free`.

## Suggest mode (default)

Each ordinary user prompt triggers one Jev evaluation before the main agent starts. The System One request uses the configured timeout (3000 ms by default). While the evaluation runs, a temporary spinner row (`⠋ Jev 判断中…`) appears below the conversation and above the editor, with a blank line beneath it; it disappears when the evaluation ends. On success, the extension adds Jev's selected route and probabilities to the system prompt as an execution instruction. The supported routes are `direct` (handle the task without a subagent), `scout` (call the scout subagent), and `worker` (call the worker subagent). The main model still issues these tool calls, so this prompt-driven behavior cannot guarantee that the model will follow the instruction. It does not change the model, thinking level, permissions, or remote-execution settings. Missing authentication, model errors, network failures, and timeouts fail open without a route instruction.

Every evaluation also writes one persistent line to the current session, for example `Jev [Suggest] scout 69% · direct 30% · worker 1%` or `Jev [Suggest] 失败：timeout`. Probabilities are shown from highest to lowest. As soon as Jev finishes and the user prompt is saved, the custom session entry is appended to the transcript; if the prompt is not yet saved or an append fails, the result stays pending and is retried at later lifecycle boundaries. The entry is never sent to the LLM.

## Shadow mode

Shadow mode evaluates ordinary prompts in the background and logs the result without adding a suggestion to the prompt. Subagent runner processes marked by `PI_SUBAGENT_CHILD=1` are excluded in both modes to prevent recursive evaluations.

In both modes, the prompt text Pi provides to the extension (after Pi expansion) is sent to `https://opencode.ai/zen/v1/systemone`, capped at 4000 characters by default. The request also carries up to the last three previous turns: each turn's user text plus the last assistant text of that turn. Thinking, tool calls, and tool results are never included. The current prompt comes first and wins the character budget: when the cap is hit, the oldest turns are dropped first, and the prompt itself is truncated only when it alone exceeds the limit. If the prompt includes images, Jev receives only a note that images are attached, not the image data. The prompt and history are not saved in the log. Be aware that expanded prompt text may include file contents.

Set `proxyUrl` in `~/.pi/agent/jev-router.json` to route only Jev requests through an HTTP(S) or SOCKS5 proxy. For example:

```json
{
  "proxyUrl": "socks5h://127.0.0.1:7890"
}
```

Supported schemes are `http://`, `https://`, `socks5://`, and `socks5h://`. Existing settings without `proxyUrl` continue to use a direct connection. Proxy credentials may be included in the URL; the status display does not show the URL.

Use these commands in Pi:

```text
/jev-router status
/jev-router off
/jev-router on
/jev-router suggest
/jev-router shadow
```

`off` persists to `~/.pi/agent/jev-router.json` and prevents new evaluations. `on` re-enables the current mode; `suggest` and `shadow` select and enable that mode. Suggest mode requires the main agent to follow the selected route and make the corresponding subagent tool call; direct means no subagent. If the configuration is malformed, Jev fails closed and remains disabled; `/jev-router on` rewrites it with valid defaults. The default configuration is enabled Suggest mode, a 3000 ms timeout, a 4000-character input limit, JSONL logging, and direct network access (`proxyUrl: null`).

Live evaluation records go to `~/.pi/agent/jev-router-shadow.jsonl`. They include the mode, route, probabilities, session/task IDs, timing and token usage, but not the prompt text. `subagent_call` records note calls to the `subagent` tool and the selected agent name or workflow; they do not include the delegated task text and indicate a call attempt, not necessarily successful completion.

The extension source is managed in `~/dotfiles/pi/extensions/pi-jev-router/`; `pi/sync.sh` links its files into `~/.pi/agent/extensions/pi-jev-router/`. The shared `jev-router.json` template enables Suggest and logging on hosts without a local config; each host's setting remains local. Existing hosts with a previous `mode: "shadow"` config remain in Shadow until switched to Suggest. Use `/reload` in an active Pi session (or restart Pi) after syncing or changing the local mode. `pi list` lists installed packages and does not enumerate individual user-directory extensions.

## Fixed comparison test

Run `/jev-test` to evaluate the 8 fixed synthetic tasks 3 times each. You can set repetitions from 1–10:

```text
/jev-test 5
```

These records go to `~/.pi/agent/jev-router-phase1.jsonl`. They contain fixed task IDs, not task text. Repeat consistency is not decision accuracy; the examples have no authoritative labels.

## Authentication and failures

The extension looks up the classifier model through `ctx.modelRegistry` and obtains OpenCode authentication through Pi. It does not read `auth.json` or require a separate API key. Missing models, unavailable authentication, network failures, and timeouts are logged when logging is enabled. In Suggest mode, failures omit the route instruction and let the main task continue; Shadow mode never waits for Jev.

## Local tests

Node.js 22.19+:

```sh
npm test
```
