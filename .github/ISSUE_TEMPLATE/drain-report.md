---
name: Drain / run report
about: You ran glean on a real repo — tell us what it produced and whether it was worth it
title: "[drain-report] "
labels: drain-report
assignees: ''
---

> The single most useful thing you can send. Even a partial report helps.

**Environment**
- glean version (`glean version`):
- OS / Windows build:
- Pro / Max / Free:
- Single `glean run` or scheduled `--drain`?

**What it produced**
- Draft branches created: N  → kept: N, discarded: N
- Dossiers created: N        → kept: N, discarded: N, actioned: N
- Did `tests: pass` on the draft match reality when you reviewed it? (y/n)

**Capacity / drain behavior** (if you ran `--drain`)
- Did it correctly pause at the 5-hour wall and resume?
- Did it stop at the weekly cap without spilling into the new week?
- Exact rate-limit signal you saw — paste the `rate_limit_event` line from
  `%USERPROFILE%\glean\logs\<run-id>\<task-id>.jsonl` if you can find it
  (this directly helps the classifier):

**The honest question**
- Was the Monday-morning receipt worth the capacity it spent? (1–5)
- What would have made the #1 draft actually useful?

**Anything that broke**
