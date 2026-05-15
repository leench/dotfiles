---
name: hunter-delegation
description: Use when a task needs quick read-only codebase exploration before the main agent decides what to do, especially for locating entry points, tracing execution paths, identifying relevant files, or reducing main-context pollution.
---

# Hunter delegation

Use the `hunter` agent for bounded read-only code discovery.

Delegate when the parent needs facts such as:
- where a behavior is implemented
- which files or symbols are involved
- what the real execution path is
- what to inspect next before making a decision

Do not delegate trivial lookups the parent can answer immediately.
Do not use this skill for broad architecture essays or implementation work.

When delegating, give the hunter:
- one concrete question
- the narrowest useful path or module hints
- the exact output you need back

Prefer outputs that compress into:
- conclusion
- evidence
- next_step
- uncertainties
