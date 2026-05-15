---
name: mage-delegation
description: Use when a task needs bounded verification of docs, prior decisions, configuration, or external facts outside the main thread, especially when the result should be compactly summarized before the main agent acts.
---

# Mage delegation

Use the `mage` agent for bounded verification and synthesis.

Delegate when the parent needs:
- version-specific docs confirmation
- a compact comparison of options
- verification of prior decisions or config facts
- external evidence that would otherwise bloat the main context

Do not delegate if the answer is already obvious from local evidence.
Do not let the mage drift into coding or broad surveys.

When delegating, specify:
- the exact claim or question to verify
- preferred source types
- the decision the answer will support

Prefer outputs that compress into:
- answer
- evidence
- caveats
- next_step
