# glean

> Consume idle Claude Pro/Max capacity between sessions to produce speculative prep work for your next session.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Status: MVP](https://img.shields.io/badge/status-MVP-blue.svg)](#status)

You're on a Claude Pro or Max subscription. The weekly rate-limit window resets Saturday morning. By Thursday and Friday you've often spent the high-value work and have unused capacity that **doesn't roll over**.

`glean` is a local CLI that, during that idle tail-window, spawns its own headless `claude -p` sessions to do *speculative* prep work on your existing projects — drafting research dossiers, pre-fetching library docs, surfacing the TODOs and PRs you keep meaning to come back to. Next week, you open a "prep folder" and find a head-start.

> *gleaning* (n.) — the practice of gathering leftover crops from the field after the main harvest. `glean` does the same with unused capacity at the tail of your weekly rate-limit window.

## Status

**MVP, Windows-first.** Tagged `v0.1.0-mvp`. Produces `research-dossier` (from TODOs, open PRs, and Claude Code session histories) and `fetch-docs` (from recently-added dependencies) outputs for one project at a time. Linux/macOS support, scheduling, worktree-based code drafts, and other features are deferred to follow-up sub-projects — see [`glean.md`](./glean.md) for the full vision and [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./docs/superpowers/specs/2026-05-23-glean-mvp-design.md) for what this MVP does and does not include.

## Requirements

- **Node 20+**
- **Claude Code CLI** on PATH, logged in with a Pro or Max subscription (`claude --version` should work)
- **Git** for repo scanning
- *Optional:* **GitHub CLI** (`gh`) authenticated, for PR-based discovery signals — gracefully skipped if absent
- **Windows** — POSIX support is post-MVP

## Install

```bash
git clone https://github.com/Jonny-boy9000/glean.git
cd glean
npm install
npm run build
npm install -g .
glean version
```

## Configure

Create `%USERPROFILE%\glean\config.json`:

```json
{
  "claude_bin": "claude"
}
```

The `claude_bin` field points at your Claude CLI executable (default: `claude` on PATH). In MVP this is the only required field.

## Use

```powershell
# Discover and rank candidates — does NOT burn capacity
glean run --project C:\some-repo --dry-run

# Run for 60 minutes against the real Claude subscription
glean run --project C:\some-repo

# Custom budget
glean run --project C:\some-repo --budget 90m

# Stop an active run between tasks (from any shell)
glean stop
```

`glean` exits with structured codes so you can wire it into scripts:

| Code | Meaning |
|---|---|
| 0 | Completed normally (or no candidates found) |
| 10 | Wall-clock budget exhausted |
| 20 | Claude rate-limit detected — stopped cleanly |
| 30 | STOP sentinel triggered (`glean stop`) |
| 40 | Another `glean run` is holding the lock |
| 1 | Unexpected error |

## Where output goes

```
%USERPROFILE%\glean\
  dossiers\<project>\<YYYY-MM-DD>\
    INDEX.md                          ← start here on Monday morning
    research-<slug>\OUT.md            ← one per research dossier
    docs\<library>.md                 ← one per fetch-docs task
  state\<run-id>\
    candidates.json                   ← ranked candidate list (for debugging)
    summary.json                      ← run outcome and counts
  logs\<run-id>\
    orchestrator.log                  ← ndjson event log
    <task-id>.jsonl                   ← raw claude -p stream
    <task-id>.stderr                  ← raw stderr
```

`INDEX.md` is the human-facing menu — open it first.

## How it works

Three discovery sources run in parallel:

1. **Claude Code session history** — scans `~/.claude/projects/<project>/*.jsonl` for sessions whose AI-generated title mentions TODO/FIXME/etc.
2. **`git grep` for `TODO`/`FIXME`/`XXX`/`HACK`** plus `gh pr list` (if available) for unresolved review comments.
3. **Recently-added dependencies** in `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml` (last 14 days via `git log`).

Each candidate becomes a single `claude -p` invocation, sandboxed inside a Windows Job Object so the child tree dies cleanly on Ctrl-C or `glean stop`. The spawned Claude session runs with `--disallowedTools` blocking `git push`, `git checkout main`, and `gh pr` mutations — speculative work only, no production-affecting changes.

For the full architecture see [`docs/superpowers/specs/2026-05-23-glean-mvp-design.md`](./docs/superpowers/specs/2026-05-23-glean-mvp-design.md).

## Discard

No `glean discard` in MVP — to throw away a day's output:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\glean\dossiers\<project>\<YYYY-MM-DD>"
```

## What's not in MVP

- `draft-impl` candidate type (Claude writes speculative code into git worktrees)
- Scheduling (Windows Task Scheduler, cron, launchd)
- `glean discard`, `glean gc`, `glean peek` commands
- SessionStart hook
- Rate-limit back-off ladder + circuit breaker
- Resume after crash
- Multi-project per run
- Parallelism (`max_parallel > 1`)
- Linux/macOS native support

These will land in follow-up sub-projects. See [`glean.md`](./glean.md) for the full vision.

## Contributing

This is an early MVP — issues, ideas, and PRs welcome.

If you're adding a feature, start with `glean.md` (the vision doc) and the MVP design spec under `docs/superpowers/specs/` to understand what's intentionally out of scope versus genuinely missing. The implementation plan at `docs/superpowers/plans/2026-05-23-glean-mvp.md` shows how the existing code was structured task-by-task; new features should follow the same modular pattern (one file per responsibility, TDD-style tests, ~600–1200 LOC sub-projects).

To run tests locally:

```bash
npm test          # full suite (~2 min)
npm run lint
npm run build
```

The test stub `test/fixtures/fake-claude.cmd` simulates `claude -p` so integration tests don't burn real subscription capacity.

## License

[MIT](./LICENSE) — © 2026 Jonny
