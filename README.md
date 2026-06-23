# glean

> **Glean turns your unused Friday Claude capacity into a Monday-morning head-start.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757)](https://claude.com/claude-code)

> **🍎 macOS / Linux:** glean is Windows-first, with **Linux support in beta** (see [Linux (beta)](#linux-beta)). macOS is the remaining gap — tracked in [issue #1](https://github.com/Jonny-boy9000/glean/issues/1), PRs very welcome.

You're on a Claude Pro or Max subscription. The weekly rate-limit window resets at a fixed time each week assigned to your account — not a fixed calendar day, and glean learns yours. By the tail of your week you've often spent the high-value work and have unused capacity that **doesn't roll over**.

`glean` is a local CLI that, during that idle tail-window, spawns its own headless `claude -p` sessions to do *speculative* prep work on your existing projects — **drafting reviewable code branches** for your top TODOs (in isolated git worktrees, never touching `main`), drafting research dossiers, and pre-fetching library docs. Point Windows Task Scheduler at it (`glean schedule enable`) and it **drains the whole weekend's leftover capacity unattended** — exiting and re-launching itself across each 5-hour rate-limit window until the weekly cap resets. Monday morning you run `glean morning` and get a receipt of everything it did.

> *gleaning* (n.) — the practice of gathering leftover crops from the field after the main harvest. `glean` does the same with unused capacity at the tail of your weekly rate-limit window.

<p align="center">
  <img src="https://raw.githubusercontent.com/Jonny-boy9000/glean/main/docs/assets/glean-morning.png" alt="glean morning receipt: an AI-drafted branch with a best-effort 'tests: pass', main branch untouched" width="760">
</p>
<p align="center"><em><code>glean morning</code> — the Monday-morning payoff: a reviewable draft branch with a best-effort <code>tests: pass</code> (glean re-runs your test command out-of-session to check), your <code>main</code> never touched.</em></p>

---

## Is this allowed?

**As of 2026-06-23, yes — with honest caveats.** `glean` drives *your own* logged-in Claude Code CLI via headless `claude -p` — Anthropic's own official binary. No API key, no proxying, no shared accounts, **no token extraction**. That makes it categorically different from the third-party token-extraction harnesses Anthropic has acted against (the "OpenClaw" class). Today, headless `claude -p` still draws from your normal Pro/Max subscription limits.

Two qualifications we'd rather state than bury:
1. Anthropic's Consumer Terms permit non-API automation "where we otherwise explicitly permit it"; glean drives the *official* CLI, which is the gray-but-defensible basis here. *Unattended/scheduled* use specifically isn't spelled out either way.
2. Anthropic announced — then **paused** (June 2026) — a change that would meter headless `claude -p` onto separate credits. If it returns, glean's free-idle-capacity premise changes, and it's built to adapt ([ADR-0008](./docs/decisions/0008-spawn-backend-seam.md)). We watch this weekly.

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

**Requirements:** Node 20+, the `claude` CLI on PATH (logged into a Pro/Max subscription), Git. Optional: `gh` for PR-based discovery. The scheduler supports **Windows** (Task Scheduler, the battle-tested path) and **Linux** (systemd user timer, beta — see [Linux (beta)](#linux-beta)).

### Linux (beta)

The Linux port is new and has had far less mileage than the Windows path — treat it as beta and check `glean morning` after your first scheduled weekend.

- `glean schedule enable` writes a **systemd user timer** (`glean-drain.timer` + `glean-drain.service` in `~/.config/systemd/user/`) and runs `systemctl --user enable --now glean-drain.timer`. The timer fires weekly (`OnCalendar=<Day> 18:00`) with `Persistent=true`, so a run missed while the laptop was asleep fires on wake.
- If systemd `--user` is unavailable (some containers/WSL setups), it falls back to a **crontab** line with hourly re-entry through the weekend window (e.g. `0 18-23,0-6 * * 4,5,6`).
- One behavioral difference from Windows: the systemd timer fires **once per week** (Persistent catch-up included) rather than hourly through the window, so a drain tick that exits on a 5-hour rate limit is not re-launched until the next weekly fire; the cron fallback re-enters hourly. Mid-window re-entry parity is open work.
- Config lives at `~/glean/config.json`; output at `~/glean/`.
- **macOS (launchd) is still future work** — `glean schedule` errors politely there; manual `glean run` works anywhere Node and the `claude` CLI do.

### Commands

| Command | What it does |
|---|---|
| `glean run --project <path> [--budget 60m] [--dry-run]` | One discovery + execution pass (a "burst"). |
| `glean run --drain --project <path>` | A drain *tick*: run a burst, and on a 5-hour rate-limit save state and exit so the scheduler can re-launch it. |
| `glean schedule enable\|disable\|status` | Register/remove the weekly schedule that drives the drain (Windows Task Scheduler, or a Linux systemd user timer). |
| `glean serve [--port 4317] [--open]` | Launch the local management dashboard (127.0.0.1 only): browse runs/dossiers, view per-task streams, and manage operation — Run now, Stop/Resume, retry failed tasks, discard/rate dossiers, toggle the schedule. **`glean serve install`** keeps it always on (auto-start at logon + restart on failure; `uninstall` / `status` manage it). See the [dashboard guide](docs/guides/dashboard.md). |
| `glean morning [--md]` | The "while you slept" receipt for the latest run/drain window. `--md` prints shareable Markdown. |
| `glean usage [--json]` | Weekly pacing report: this week's capacity spend vs. your own per-weekday baseline, the pace tier, and the last captured rate-limit utilization. `--json` for scripting. |
| `glean projects [set <path> <off\|low\|normal\|high>]` | List the project portfolio (every Claude project on the machine + configured ones) or steer a project's priority dial. |
| `glean today` | Today's dossiers across all projects. |
| `glean rate <id> <kept\|discarded\|actioned>` | Record whether a dossier was useful (usefulness telemetry). |
| `glean doctor` | Environment preflight: Node 20+, `claude` on PATH, git (gh optional), config, native deps. Exits non-zero if a hard requirement is missing. |
| `glean gc` | Expire draft-impl worktrees + `prep/glean-*` branches older than 21 days. |
| `glean stop` | Halt the active run/drain between tasks. |

### The dashboard (`glean serve`)

Everything glean does, in one local page — every run with its outcome and ok/failed ratio, every dossier (view, rate, discard), live session-window capacity from captured `rate_limit_event` telemetry, and one-click management (Run now, Stop/Resume, retry failed tasks, toggle the schedule). Binds to `127.0.0.1` only. Run `glean serve install` once and it is always there — auto-started at logon (Windows scheduled task / Linux systemd user service) and restarted if it dies; plain `glean serve` stays terminal-bound.

<p align="center">
  <img src="https://raw.githubusercontent.com/Jonny-boy9000/glean/main/docs/assets/dashboard-runs.png" alt="glean serve dashboard: runs table with outcomes, ok/failed ratio bars and durations for every drain burst" width="760">
</p>
<p align="center"><em>The Runs view — every burst the drain made, with honest outcomes (including the rate-limited one that taught us two bug fixes). Full walkthrough in the <a href="docs/guides/dashboard.md">dashboard guide</a>.</em></p>

---

## How it works

Four discovery sources run in parallel:

1. **Claude Code session history** — scans `~/.claude/projects/<project>/*.jsonl` for sessions whose AI-generated title mentions TODO/FIXME/etc.
2. **`git grep` for `TODO`/`FIXME`/`XXX`/`HACK`** plus `gh pr list` (if available) for unresolved review comments.
3. **Recently-added dependencies** in `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml` (last 14 days via `git log`).
4. **The project's own planning docs** (`discover-docs`) — mines `ROADMAP`/`TODO`/`BACKLOG`/`PLAN`, `docs/ROADMAP.md`, `docs/handoff/*.md`, and planning-titled root `*.md` for "up next" list items and unchecked `- [ ]` tasks, so the work you already wrote down becomes prep candidates.

Each candidate becomes a single `claude -p` invocation, wrapped in a Windows Job Object so the child tree dies cleanly on Ctrl-C or `glean stop` (the Job Object bounds process *lifetime*, not filesystem access). The spawned Claude session runs with a `--disallowedTools` deny-list blocking `git push`, `git switch`/`checkout`/`reset`/`branch`/`worktree`, and `gh pr` mutations, plus a scoped `--allowedTools` allow-list — so `main` is never checked out, pushed, or merged. Speculative work only.

**Code drafts (`draft-impl`).** For a project with a `base_branch` set in config, the single highest-value TODO is implemented into an isolated `git worktree` on a `prep/glean-*` branch off that base. Your `main` is never checked out, mutated, pushed, or merged — review by `cd`-ing into the worktree (the receipt prints the exact command). glean runs the project's `test_command` inside the worktree and reports `pass`/`fail`/`none`.

**The drain (`--drain` + `glean schedule`).** A weekly cap on Pro/Max is a rolling 7-day window, and a separate 5-hour session window throttles how much you can use at once — so draining a big leftover bucket means working until the 5-hour wall, waiting ~5h, and going again, several times across the weekend. glean does this by **exit-and-re-enter**: on a 5-hour rate-limit it classifies the reset *horizon* and pauses or stops accordingly (hours → session, pause and resume; days → weekly cap, stop and report "drained weekly capacity"), persists `next_eligible_at` + a resume cursor to `state/budget.json`, and exits. The reset signal it reads is the structured `rate_limit_event` that `claude -p` emits in its stream-json output (session-limit shape verified live; the stderr-prose regex is kept only as a fallback). The Windows Task Scheduler trigger re-launches it after the window reopens. It never sleeps in-process (that dies at laptop lid-close), and never spills into the fresh new-week allowance.

**The capacity governor.** `glean usage` reports your self-relative weekly pacing — this week's capacity spend against your own per-weekday baseline — so you can see whether you're under- or over-spending before the drain does. Speculative work is routed to Sonnet by default (`--model sonnet`): on Max plans Sonnet has its own weekly pool and burns the shared cap several times slower than Opus.

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

Run `glean morning` (or open `RECEIPT.md`) for the human-readable summary: each draft branch with its diff stat and best-effort test status (glean re-runs your test command out-of-session; `pass`/`fail`/`none`), the review/discard commands, dossiers, and an honest capacity line. `glean morning --md` prints it as Markdown to paste into a PR or Slack.

---

## FAQ

**Will it burn my whole weekly limit?**
A plain `glean run` won't: default budget is 60 minutes (`--budget 60m`), checked between every task, and it exits cleanly when exhausted. `glean run --drain` is the opposite by design — it *intentionally* consumes the leftover weekly capacity, but only the leftover: it pauses at each 5-hour limit and resumes after the window reopens, then **stops the moment the weekly cap fires** rather than carrying on into the next week. It only claims "drained weekly capacity" when the weekly-limit signal actually appeared. (A pre-emptive margin that refuses to *start* a task in the final minutes before the reset is still on the roadmap; today it stops as soon as the weekly signal returns.)

**Do I actually have idle capacity to glean?**
"Free idle capacity" is *conditional* — it assumes you have an idle **tail** on your **shared** weekly pool (the same cap funds Claude Code + claude.ai chat + Cowork). A heavy week can leave none, in which case a drain competes with your own real sessions. Run **`glean usage`** to see your self-relative pace *before* `glean schedule enable` — the pace-gated drain only spends when you're underspending. And if you opted into **extra usage** (Settings → Usage, off by default), draining past your included limit is billed at API rates — so it isn't strictly "use it or lose it" for you. (See [ADR-0012](./docs/decisions/0012-conditional-economic-thesis.md).)

**Does it touch my main branch?**
No. Research dossiers and fetched docs live under `%USERPROFILE%\glean\` (your repos read-only). Code drafts (`draft-impl`, since v0.7.0) go into an isolated `git worktree` on a disposable `prep/glean-*` branch off your configured `base_branch` — `main` is never checked out, mutated, pushed, or merged. Every spawned `claude -p` runs under a deny-list blocking `git push`/`switch`/`checkout`/`reset`/`branch`/`worktree` and `gh pr merge`/`create`; git itself also refuses to let a linked worktree move another worktree's HEAD.

**What if I'm not on Pro/Max?**
You'll need *some* logged-in `claude` CLI. The free tier's stricter rate limits will cause glean to exit early via the rate-limit signal — it'll still work, just produce less per run.

**How much does a typical run consume?**
The dogfood run against this repo (1178 LOC, 25 candidates discovered, 14 ran) used about 28 minutes of wall-clock and produced 14 OUT.md files. Your mileage varies with project size and budget.

**What if I cancel mid-run?**
Either Ctrl-C the orchestrator or run `glean stop` from another shell. Both kill the child `claude -p` tree (a tree-kill via `taskkill /T` on Windows, a process-group `SIGKILL` on Linux) and exit cleanly. `glean stop` is checked *between* tasks, so the in-flight task finishes naturally before the run exits with code 30.

**Can I run it on a schedule?**
Yes, on Windows and Linux. `glean schedule enable --project <path>` registers one Windows Scheduled Task — or, on Linux, a systemd user timer (see [Linux (beta)](#linux-beta)) — that drives the weekend drain. The default trigger day is detected from your system timezone — Thursday for Israel's Sun–Thu work week, Friday otherwise. On Windows the task is battery-safe and runs only when you're logged on. `glean schedule disable` removes it. (macOS launchd is on the [roadmap](#coming-next).)

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
| 50 | Claude auth failed (expired/missing login) — stopped cleanly; re-run `claude /login` |
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
  "strict_spawn": false,
  "projects": {
    "C:\\code\\my-app": {
      "base_branch": "main",
      "test_command": "npm test"
    }
  },
  "drain_trigger": { "day": "Friday", "time": "18:00", "repeat_minutes": 60, "duration_hours": 60 },
  "models": { "fetch-docs": "haiku", "research-dossier": "sonnet", "draft-impl": "sonnet" },
  "max_turns": { "fetch-docs": 8, "research-dossier": 24, "draft-impl": 50 },
  "pacing": { "enabled": true, "haircut": 0 }
}
```

- **`claude_bin`** — point at a specific `claude` executable if it isn't on PATH.
- **`strict_spawn`** — safety posture for the `draft-impl` spawn (default `false`). On native Windows there is no OS sandbox, so an in-session test runner executes a subprocess *outside* Claude Code's permission layer. By default glean already excludes the arbitrary-code verbs `node`/`npm run` and keeps only your declared test runner so a draft can still self-verify. Set `strict_spawn: true` to drop in-session code execution **entirely** — the session can only edit files inside the worktree and run `git add`/`commit` — a hard "read-only against `main`" guarantee on every platform, at the cost of the model running your tests in-session (glean still re-runs them out-of-session for the receipt's status). See [ADR-0009](./docs/decisions/0009-spawned-session-trust-boundary.md).
- **`projects.<absolute-path>.base_branch`** — **enables code drafts (`draft-impl`)** for that project; the draft worktree is branched off this ref. Without it, that project gets dossiers/docs only.
- **`projects.<absolute-path>.test_command`** — what glean runs inside the draft worktree to capture a `pass`/`fail`/`none` test status (also scopes the draft session's Bash allow-list).
- **`drain_trigger`** — overrides the scheduler default (day/time/repetition). Omit it to let `glean schedule enable` auto-detect the day from your timezone.
- **`models`** — per-task-type `--model` for spawned sessions (alias like `sonnet` or a full model id). The values shown are the built-in defaults: speculative work runs on Sonnet (on Max plans it has its own weekly pool and burns the shared cap several times slower than Opus), doc fetches on Haiku. The resolved model is logged per task. Omit the key entirely to use the defaults.
- **`max_turns`** — per-task-type `--max-turns` runaway-loop guard on every spawned session (orthogonal to the per-task timeout). The values shown are the defaults.
- **`pacing`** — the capacity-governor gate behind `glean usage`. `enabled` (default `true`) turns self-relative pacing on/off; `haircut` (0–1, default 0) is a manual discount you can add to the measured pace ratio to account for capacity glean can't see locally (claude.ai web/desktop or other machines that share your cap but write no JSONL here). An optional `thresholds` object (`skip_above`/`small_above`/`normal_above`) overrides the tier boundaries. Omit the whole key to use the defaults.

To discard a day's output:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\glean\dossiers\<project>\<YYYY-MM-DD>"
```

---

## Coming next

- **Capacity-governor wave 2** — a nightly schedule preset gated by `glean usage`'s pace tier (only drain on the nights you're underspending), and a morning anti-spill margin that ends a drain N hours before your typical first prompt so a run never eats into the day's fresh capacity.
- **API-key fallback** — when Pro/Max rate-limits, optionally fall back to `ANTHROPIC_API_KEY` for the rest of the budget.
- **macOS** — launchd scheduling, the remaining platform gap now that Linux is in beta; see [issue #1](https://github.com/Jonny-boy9000/glean/issues/1).

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
