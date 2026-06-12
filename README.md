# glean

> **Glean turns your unused Friday Claude capacity into a Monday-morning head-start.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757)](https://claude.com/claude-code)

> **🍎 macOS / Linux:** glean is Windows-first today. Cross-platform support is the [top tracked issue](https://github.com/Jonny-boy9000/glean/issues/1) — PRs very welcome.

You're on a Claude Pro or Max subscription. The weekly rate-limit window resets Saturday morning. By Thursday and Friday you've often spent the high-value work and have unused capacity that **doesn't roll over**.

`glean` is a local CLI that, during that idle tail-window, spawns its own headless `claude -p` sessions to do *speculative* prep work on your existing projects — **drafting reviewable code branches** for your top TODOs (in isolated git worktrees, never touching `main`), drafting research dossiers, and pre-fetching library docs. Point Windows Task Scheduler at it (`glean schedule enable`) and it **drains the whole weekend's leftover capacity unattended** — exiting and re-launching itself across each 5-hour rate-limit window until the weekly cap resets. Monday morning you run `glean morning` and get a receipt of everything it did.

> *gleaning* (n.) — the practice of gathering leftover crops from the field after the main harvest. `glean` does the same with unused capacity at the tail of your weekly rate-limit window.

<p align="center">
  <img src="https://raw.githubusercontent.com/Jonny-boy9000/glean/main/docs/assets/glean-morning.png" alt="glean morning receipt: an AI-drafted branch with a verified 'tests: pass', main branch untouched" width="760">
</p>
<p align="center"><em><code>glean morning</code> — the Monday-morning payoff: a reviewable draft branch with a verified <code>tests: pass</code>, your <code>main</code> never touched.</em></p>

---

## Is this allowed?

**Yes.** `glean` drives *your own* logged-in Claude Code CLI — the same headless `claude -p` invocations you could type by hand. No API key, no proxying, no shared accounts. You're using *your* subscription, just on a schedule.

(The earlier, rejected design for this project *was* an MCP that resold leftover tokens. That idea is documented as explicitly dropped in [`glean.md`](./glean.md) §2 because it would have violated Anthropic's Usage Policies and Commercial Terms.)

---

## Quick start

```bash
npm i -g @jonny-boy9000/glean

# Dry-run first — discovers and ranks candidates without spawning Claude
glean run --project C:\some-repo --dry-run

# Then the real thing — 60-minute default budget
glean run --project C:\some-repo

# Monday morning: see what it did
glean morning
```

To drain the whole weekend automatically, register the scheduled task once:

```bash
glean schedule enable --project C:\some-repo
# "drain scheduled: Thursday 18:00 (detected from your system timezone Asia/Jerusalem)
#  — override: glean schedule enable --day Friday"
```

First run auto-creates `%USERPROFILE%\glean\config.json` with sensible defaults. See [Advanced configuration](#advanced-configuration) to set a project's `base_branch` (enables code drafts) or override the schedule.

**Requirements:** Node 20+, the `claude` CLI on PATH (logged into a Pro/Max subscription), Git. Optional: `gh` for PR-based discovery. The scheduler is **Windows-only** today.

### Commands

| Command | What it does |
|---|---|
| `glean run --project <path> [--budget 60m] [--dry-run]` | One discovery + execution pass (a "burst"). |
| `glean run --drain --project <path>` | A drain *tick*: run a burst, and on a 5-hour rate-limit save state and exit so the scheduler can re-launch it. |
| `glean schedule enable\|disable\|status` | Register/remove the weekly Windows Scheduled Task that drives the drain. |
| `glean serve [--port 4317] [--open]` | Launch the local management dashboard (127.0.0.1 only): browse runs/dossiers, view per-task streams, and manage operation — Run now, Stop/Resume, retry failed tasks, discard/rate dossiers, toggle the schedule. |
| `glean morning [--md]` | The "while you slept" receipt for the latest run/drain window. `--md` prints shareable Markdown. |
| `glean today` | Today's dossiers across all projects. |
| `glean rate <id> <kept\|discarded\|actioned>` | Record whether a dossier was useful (usefulness telemetry). |
| `glean gc` | Expire draft-impl worktrees + `prep/glean-*` branches older than 21 days. |
| `glean stop` | Halt the active run/drain between tasks. |

---

## How it works

Three discovery sources run in parallel:

1. **Claude Code session history** — scans `~/.claude/projects/<project>/*.jsonl` for sessions whose AI-generated title mentions TODO/FIXME/etc.
2. **`git grep` for `TODO`/`FIXME`/`XXX`/`HACK`** plus `gh pr list` (if available) for unresolved review comments.
3. **Recently-added dependencies** in `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml` (last 14 days via `git log`).

Each candidate becomes a single `claude -p` invocation, sandboxed inside a Windows Job Object so the child tree dies cleanly on Ctrl-C or `glean stop`. The spawned Claude session runs with a `--disallowedTools` deny-list blocking `git push`, `git switch`/`checkout`/`reset`/`branch`/`worktree`, and `gh pr` mutations — speculative work only, no production-affecting changes.

**Code drafts (`draft-impl`).** For a project with a `base_branch` set in config, the single highest-value TODO is implemented into an isolated `git worktree` on a `prep/glean-*` branch off that base. Your `main` is never checked out, mutated, pushed, or merged — review by `cd`-ing into the worktree (the receipt prints the exact command). glean runs the project's `test_command` inside the worktree and reports `pass`/`fail`/`none`.

**The drain (`--drain` + `glean schedule`).** A weekly cap on Pro/Max is a rolling 7-day window, and a separate 5-hour session window throttles how much you can use at once — so draining a big leftover bucket means working until the 5-hour wall, waiting ~5h, and going again, several times across the weekend. glean does this by **exit-and-re-enter**: on a 5-hour rate-limit it classifies the reset *horizon* from stderr (hours → session, pause and resume; days → weekly cap, stop and report "drained weekly capacity"), persists `next_eligible_at` + a resume cursor to `state/budget.json`, and exits. The Windows Task Scheduler trigger re-launches it after the window reopens. It never sleeps in-process (that dies at laptop lid-close), and never spills into the fresh new-week allowance.

For the full architecture see the design spec under [`docs/superpowers/specs/`](./docs/superpowers/specs/).

---

## What you get back

After a run completes, open `INDEX.md` for the day. It looks like this:

```markdown
---
run_id: 2026-05-24-1221-a69612
project_path: C:\Glean
generated_at: 2026-05-24T12:38:11-04:00
entries:
  - task_id: 8e7c…
    type: research-dossier
    title: "Handle TODO in src/lib/executor.ts"
    output: research-handle-todo-in-src-lib-executor-ts/OUT.md
    status: ok
---

# Glean dossier — 2026-05-24

1. **Handle TODO in src/lib/executor.ts** — ok
   - Read: `research-handle-todo-in-src-lib-executor-ts/OUT.md`

2. **Pre-fetch docs for zod** — ok
   - Read: `docs/zod.md`
```

Each linked `OUT.md` is a structured note Claude wrote during the idle window — summary, findings, suggested next actions, open questions. Average size in real dogfood runs is ~5KB of focused, actionable prose. ([Real example output here.](./docs/open-work/03-dogfood-results.md))

### Output tree

```
%USERPROFILE%\glean\
  dossiers\<project>\<YYYY-MM-DD>\
    INDEX.md                          ← machine-readable index
    RECEIPT.md                        ← shareable "while you slept" receipt (also: glean morning)
    research-<slug>\OUT.md            ← one per research dossier
    docs\<library>.md                 ← one per fetch-docs task
  work\<project>-<slug>\              ← draft-impl git worktrees (prep/glean-* branches)
  state\
    budget.json                       ← cross-invocation drain state (next_eligible_at, resume cursor)
    <run-id>\
      candidates.json                 ← ranked candidate list (for debugging)
      summary.json                    ← run outcome and counts
  logs\<run-id>\
    orchestrator.log                  ← ndjson event log
    <task-id>.jsonl                   ← raw claude -p stream
    <task-id>.stderr                  ← raw stderr
```

Run `glean morning` (or open `RECEIPT.md`) for the human-readable summary: each draft branch with its diff stat and verified test status, the review/discard commands, dossiers, and an honest capacity line. `glean morning --md` prints it as Markdown to paste into a PR or Slack.

---

## FAQ

**Will it burn my whole weekly limit?**
A plain `glean run` won't: default budget is 60 minutes (`--budget 60m`), checked between every task, and it exits cleanly when exhausted. `glean run --drain` is the opposite by design — it *intentionally* consumes the leftover weekly capacity, but only the leftover: it pauses at each 5-hour limit and resumes after the window reopens, then **stops the moment the weekly cap fires** rather than carrying on into the next week. It only claims "drained weekly capacity" when the weekly-limit signal actually appeared. (A pre-emptive margin that refuses to *start* a task in the final minutes before the reset is still on the roadmap; today it stops as soon as the weekly signal returns.)

**Does it touch my main branch?**
No. Research dossiers and fetched docs live under `%USERPROFILE%\glean\` (your repos read-only). Code drafts (`draft-impl`, since v0.7.0) go into an isolated `git worktree` on a disposable `prep/glean-*` branch off your configured `base_branch` — `main` is never checked out, mutated, pushed, or merged. Every spawned `claude -p` runs under a deny-list blocking `git push`/`switch`/`checkout`/`reset`/`branch`/`worktree` and `gh pr merge`/`create`; git itself also refuses to let a linked worktree move another worktree's HEAD.

**What if I'm not on Pro/Max?**
You'll need *some* logged-in `claude` CLI. The free tier's stricter rate limits will cause glean to exit early via the rate-limit signal — it'll still work, just produce less per run.

**How much does a typical run consume?**
The dogfood run against this repo (1178 LOC, 25 candidates discovered, 14 ran) used about 28 minutes of wall-clock and produced 14 OUT.md files. Your mileage varies with project size and budget.

**What if I cancel mid-run?**
Either Ctrl-C the orchestrator or run `glean stop` from another shell. Both kill the child `claude -p` tree (via a Windows Job Object) and exit cleanly. `glean stop` is checked *between* tasks, so the in-flight task finishes naturally before the run exits with code 30.

**Can I run it on a schedule?**
Yes, on Windows. `glean schedule enable --project <path>` registers one Windows Scheduled Task that drives the weekend drain. The default trigger day is detected from your system timezone — Thursday for Israel's Sun–Thu work week, Friday otherwise — and the task is battery-safe and runs only when you're logged on. `glean schedule disable` removes it. (macOS launchd / Linux cron are on the [roadmap](#coming-next).)

---

## Scripting

`glean` exits with structured codes so you can wire it into shell scripts:

| Code | Meaning |
|---|---|
| 0 | Completed normally (or no candidates found) |
| 10 | Wall-clock budget exhausted |
| 20 | Claude rate-limit detected — stopped cleanly |
| 30 | STOP sentinel triggered (`glean stop`) |
| 40 | Another `glean run` is holding the lock |
| 1 | Unexpected error |

The orchestrator also writes a structured ndjson event log at `%USERPROFILE%\glean\logs\<run-id>\orchestrator.log` and a final `summary.json` capturing reason + counts.

---

## Auto-load dossiers into Claude sessions

`glean peek` is a CWD-scoped variant of `glean today` designed for use as a SessionStart hook. When you start a Claude Code session inside a repo that has a recent glean dossier, the hook auto-loads the dossier into the session's context.

Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "glean peek" }
        ]
      }
    ]
  }
}
```

`glean peek` exits silently when there's nothing to show (no git repo, no dossier for today, any error) so it never breaks a session.

---

## Advanced configuration

`%USERPROFILE%\glean\config.json` is auto-created on first run:

```json
{
  "claude_bin": "claude",
  "projects": {
    "C:\\code\\my-app": {
      "base_branch": "main",
      "test_command": "npm test"
    }
  },
  "drain_trigger": { "day": "Friday", "time": "18:00", "repeat_minutes": 60, "duration_hours": 60 }
}
```

- **`claude_bin`** — point at a specific `claude` executable if it isn't on PATH.
- **`projects.<absolute-path>.base_branch`** — **enables code drafts (`draft-impl`)** for that project; the draft worktree is branched off this ref. Without it, that project gets dossiers/docs only.
- **`projects.<absolute-path>.test_command`** — what glean runs inside the draft worktree to capture a `pass`/`fail`/`none` test status (also scopes the draft session's Bash allow-list).
- **`drain_trigger`** — overrides the scheduler default (day/time/repetition). Omit it to let `glean schedule enable` auto-detect the day from your timezone.

To discard a day's output:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\glean\dossiers\<project>\<YYYY-MM-DD>"
```

---

## Coming next

- **Drain robustness** — a configurable circuit-breaker, first-class mid-weekend candidate re-discovery (so a multi-day drain isn't working off a Thursday snapshot), and an anti-spill pre-emptive margin. Plus one real overnight drain run to capture the exact `claude -p` rate-limit stderr wording (the classifier is horizon-first, so it degrades gracefully until then).
- **API-key fallback** — when Pro/Max rate-limits, optionally fall back to `ANTHROPIC_API_KEY` for the rest of the budget.
- **macOS / Linux** — POSIX port (scheduling via launchd/cron); see [issue #1](https://github.com/Jonny-boy9000/glean/issues/1).

Plus smaller items on the [issue tracker](https://github.com/Jonny-boy9000/glean/issues). The full vision is documented in [`glean.md`](./glean.md) and the actionable plan in [`docs/ROADMAP.md`](./docs/ROADMAP.md).

---

## Contributing

Issues, ideas, and PRs welcome.

Start with [`glean.md`](./glean.md) (the vision doc) and the design spec under [`docs/superpowers/specs/`](./docs/superpowers/specs/) to understand what's intentionally out of scope versus genuinely missing. The implementation plan under [`docs/superpowers/plans/`](./docs/superpowers/plans/) shows how the existing code was structured task-by-task — new features should follow the same modular pattern (one file per responsibility, TDD-style tests, ~600–1200 LOC sub-projects).

To run tests locally:

```bash
npm test          # full suite, ~2 min
npm run lint
npm run build
```

The test stub at `test/fixtures/fake-claude.cmd` simulates `claude -p` so integration tests don't burn real subscription capacity.

---

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md) for what's new in each release.

---

## License

[MIT](./LICENSE) — © 2026 [Jonny-boy9000](https://github.com/Jonny-boy9000)

---

⭐ **Star to follow the roadmap from MVP → v1.** Questions, war stories, or ideas? Open a [discussion](https://github.com/Jonny-boy9000/glean/discussions) or an [issue](https://github.com/Jonny-boy9000/glean/issues).
