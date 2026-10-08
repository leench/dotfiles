# pi-jev-router

Jev task-routing evaluation for Pi. The extension uses Pi's model registry and existing OpenCode authentication to call OpenCode Zen System One with `jev-1.13-free`.

## Shadow mode

When enabled, each ordinary user prompt triggers one Jev evaluation in the background. The result is logged but **not added to the prompt, shown as a suggestion, or used to launch a subagent**. The main task continues without waiting for Jev. Subagent runner processes marked by `PI_SUBAGENT_CHILD=1` are excluded to prevent recursive evaluations.

The prompt text Pi provides to the extension (after Pi expansion) is sent to `https://opencode.ai/zen/v1/systemone`, capped at 4000 characters by default. If the prompt includes images, Jev receives only a note that images are attached, not the image data. The prompt itself is not saved in the log. Be aware that expanded prompt text may include file contents.

Use these commands in Pi:

```text
/jev-router status
/jev-router off
/jev-router on
```

`off` persists to `~/.pi/agent/jev-router.json` and prevents future evaluations. If the configuration is malformed, Shadow fails closed and remains disabled; `/jev-router on` rewrites it with valid defaults. The default configuration is enabled, Shadow-only, a 3000 ms timeout, a 4000-character input limit, and JSONL logging.

Live evaluation records go to `~/.pi/agent/jev-router-shadow.jsonl`. They contain the route, probabilities, session/task IDs, timing and token usage, but not the prompt text. `subagent_call` records note calls to the `subagent` tool and the selected agent name or workflow; they do not include the delegated task text and indicate a call attempt, not necessarily successful completion.

The extension source is managed in `~/dotfiles/pi/extensions/pi-jev-router/`; `pi/sync.sh` links its files into `~/.pi/agent/extensions/pi-jev-router/`. The shared `jev-router.json` template enables Shadow and logging on hosts without a local config; each host's `/jev-router on|off` setting remains local. Use `/reload` in an active Pi session (or restart Pi) after syncing. `pi list` lists installed packages and does not enumerate individual user-directory extensions.

## Fixed comparison test

Run `/jev-test` to evaluate the 8 fixed synthetic tasks 3 times each. You can set repetitions from 1–10:

```text
/jev-test 5
```

These records go to `~/.pi/agent/jev-router-phase1.jsonl`. They contain fixed task IDs, not task text. Repeat consistency is not decision accuracy; the examples have no authoritative labels.

## Authentication and failures

The extension looks up the classifier model through `ctx.modelRegistry` and obtains OpenCode authentication through Pi. It does not read `auth.json` or require a separate API key. Missing models, unavailable authentication, network failures, and timeouts are logged when logging is enabled; Shadow errors do not stop or modify the main task.

## Local tests

Node.js 22.19+:

```sh
npm test
```
