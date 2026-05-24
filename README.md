# glean

> Consume idle Claude Pro/Max capacity between sessions to produce speculative prep work for your next session.

**Status:** MVP. Windows-first. See [`glean.md`](./glean.md) for the full vision; see [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./docs/superpowers/specs/2026-05-23-glean-mvp-design.md) for what this MVP does and does not include.

## Install

```bash
git clone <this-repo> C:\Glean
cd C:\Glean
npm install
npm run build
npm install -g .
glean version
```

Requires Node 20+, the `claude` CLI on PATH (logged in with a Pro/Max subscription), and optionally the `gh` CLI for PR-based discovery signals.

## Configure

Create `%USERPROFILE%\glean\config.json`:

```json
{
  "claude_bin": "claude",
  "projects": {
    "C:\\Glean": {}
  }
}
```

(In MVP, the only field that does anything is `claude_bin`. `projects.<path>.base_branch` is accepted but unused.)

## Use

```powershell
# Find and produce prep dossiers for one project
glean run --project C:\some-repo

# 90-minute budget instead of the 60-minute default
glean run --project C:\some-repo --budget 90m

# Discover and rank candidates only — don't burn capacity
glean run --project C:\some-repo --dry-run

# Stop an active run between tasks
glean stop
```

## Where output goes

```
%USERPROFILE%\glean\
  dossiers\<proj>\<YYYY-MM-DD>\
    INDEX.md                          ← start here on Monday morning
    research-<slug>\OUT.md            ← one per research dossier
    docs\<library>.md                 ← one per fetch-docs task
  state\<run-id>\
    candidates.json                   ← for debugging
    summary.json                       ← run outcome
  logs\<run-id>\
    orchestrator.log                  ← event log
    <task-id>.jsonl                   ← raw claude -p stream
    <task-id>.stderr                  ← raw stderr
```

## Discard

There is no `glean discard` in MVP. To throw away a day's output:

```powershell
Remove-Item -Recurse -Force "%USERPROFILE%\glean\dossiers\<proj>\2026-05-23"
```

## What's not in MVP

- `draft-impl` candidate type and git worktree drafting
- Scheduling (`glean schedule`)
- `glean discard`, `glean gc`, `glean peek`
- SessionStart hook
- Rate-limit back-off ladder
- Resume after crash
- Multi-project per run
- Parallelism

These will land in follow-up sub-projects. See `glean.md` for the full vision.