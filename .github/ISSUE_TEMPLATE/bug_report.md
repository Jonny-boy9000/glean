---
name: Bug report
about: Something broke during discovery, a run, a drain, or glean morning
title: "[bug] "
labels: bug
assignees: ''
---

**Environment**
- glean version (`glean version`):
- OS / Windows build:
- Node version (`node -v`):
- Pro / Max / Free:
- Single `glean run` or scheduled `--drain`?

**Command you ran**
```
glean ...
```

**What you expected vs. what happened**


**Evidence**
- `summary.json` `reason` field (under `%USERPROFILE%\glean\logs\<run-id>\`):
- Relevant lines from `orchestrator.log`:
- If a `claude -p` task failed, the matching `<task-id>.stderr` / `<task-id>.jsonl`:

**Anything else**
