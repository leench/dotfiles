---
name: paladin-delegation
description: Use when a concrete patch, plan, or implementation needs a separate read-only quality pass focused on real defects, regressions, security issues, or missing validation before finalizing.
---

# Paladin delegation

Use the `paladin` agent after there is something concrete to inspect.

Delegate when the parent wants an independent pass on:
- a non-trivial diff
- a risky migration
- behavior-sensitive changes
- a proposed plan whose failure modes matter

Do not delegate for style-only review or before enough evidence exists.
Do not ask for implementation unless the parent explicitly wants that.

When delegating, provide:
- the exact diff, files, or plan to review
- what changed
- any known risk areas

Prefer outputs that compress into:
- findings
- confidence
- suggested_checks
