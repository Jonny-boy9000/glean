# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

**Design complete, no code yet.** The repo currently contains only `glean.md` — the full design spec. There is no `bin/`, `lib/`, build system, or tests. First implementation work will scaffold the MVP described in `glean.md` §6.

When asked to "build", "implement", or "start" something here, read `glean.md` end-to-end first. The spec is the source of truth; do not re-derive decisions Jonny has already made.

## What `glean` is

A local CLI (`glean`) that consumes idle Claude Pro/Max subscription capacity at the tail of the weekly rate-limit window. It scans the user's `~/.claude/projects/*.jsonl` session history and their git repos for unfinished work, then spawns headless `claude -p` sessions to produce speculative drafts, research dossiers, and pre-fetched docs into `~/glean/`. The next session, the user opens a "prep folder" and finds a head-start.

It is **not** an API-token reseller or marketplace — that alternative was explicitly dropped (see `glean.md` §2) because Anthropic's terms prohibit reselling/proxying Claude access.

## Load-bearing constraints (do not violate)

- **Subscription auth, no API key.** Capacity is consumed by spawning `claude -p "<prompt>"` subprocesses. Never introduce direct Anthropic API calls or `ANTHROPIC_API_KEY` usage — the whole tool assumes Pro/Max session auth.
- **Read-only against the user's primary checkouts.** All speculative output goes to `git worktree`-based `prep/*` branches under `~/glean/work/` or to dossier dirs under `~/glean/dossiers/`. Never mutate the user's main checkout or push anything.
- **Spawned sessions must run with a deny-list.** Every `claude -p` invocation passes `--disallowedTools "Bash(git push:*) Bash(git checkout main:*) Bash(gh pr merge:*) Bash(gh pr create:*)"`. Do not remove these even if a task seems to need them.
- **No cross-invocation prompt caching.** Subscription auth can't manage `cache_control`; only in-session caching inside one `claude -p` call is free. Don't design around a pre-warmed cache.
- **Rate-limit budget is indirect.** There is no programmatic remaining-window endpoint on Pro/Max. The executor reacts to stderr signals (`rate limit`, `429`, `usage limit`, `5-hour limit`) with the back-off schedule in §5.2, plus a wall-clock `--budget` and a `~/glean/STOP` sentinel. Don't invent a token-counter abstraction.
- **Default `max_parallel=1`.** Subscription sessions share one rate-limit bucket, so parallelism mostly accelerates exhaustion. `--parallel 2` is exposed but is not the default.

## Architecture pointers (read `glean.md` for detail)

- **§5.1 Discovery** — three parallel read-only passes: JSONL session signals, git scan (`git grep TODO/FIXME`, stale `claude/*` branches, `gh pr list`), and `find -mtime -7`. Emits `candidates.json`.
- **§5.2 Prioritizer** — ranks by `est_value / log(est_tokens + 1)` with type weights (`draft-impl` 1.0 → `fetch-docs` 0.2). Last 30 min of budget restricts to `fetch-docs` only.
- **§5.3 Executor** — per-candidate: provision workspace (worktree for `draft-impl`, dossier dir otherwise), render template, spawn `claude -p` with `--output-format stream-json --include-partial-messages` + deny-list + 8 min timeout, capture output to `OUT.md` (or auto-commit for `draft-impl`).
- **§5.4 Dossier layout** — `~/glean/{dossiers,work,logs,state,templates}/...`. `INDEX.md` per date sorts by realized value and includes Apply/Discard hints.
- **§5.5 Scheduling** — `glean schedule enable` writes a `launchd` plist (macOS) or crontab line (Linux); off by default. Optional SessionStart hook calls `glean peek`.
- **§5.6 Safety** — `glean discard`, `glean gc` (21-day worktree expiry), STOP sentinel checked between every task.

## MVP scope (§6)

Smallest end-to-end slice — build this first, do not pre-optimize:
- Manual trigger only, single project (`--project <path>`), 60-min budget.
- Discovery: JSONL last-`aiTitle` + `git grep TODO/FIXME` + `gh pr list`. Skip the other signals for now.
- Candidate types: `research-dossier` and `fetch-docs` only. Skip `draft-impl` worktrees in MVP.
- Serial executor, 8-min per-task timeout, clean exit on rate-limit stderr.
- Manual discard via `rm -rf`. No schedule, no hooks.

Target: ~600–900 LOC.

## Development substrate decision (§10)

**Build bare on Claude Code CLI primitives. Do not introduce Ruflo as a dependency** even though it is installed on this machine — `glean`'s runtime substrate *is* `claude -p` + git + shell, so wrapping it in Ruflo's router would abstract away the exact primitives the tool ships on top of, and would force `glean` users to install Ruflo too.

Ruflo *may* show up later as an **output integration** (writing dossiers into AgentDB so future Ruflo sessions can search them), but never as a dev dependency for the tool itself.

When developing here:
- Use the Claude Code CLI in this repo. Avoid the desktop app — the CLI exposes the shell environment the tool targets.
- Use the `loop` skill for build → test → iterate cycles during *development*, not as the tool's runtime.
- Use `git worktree` for parallel experiments — same primitive the tool will ship.
- No plugin framework; a ~900 LOC tool doesn't need one.

## Resolved decisions (override conflicting spec language)

See `glean.md` §0. Summary:

- **Windows-first.** Development happens on Windows 11; macOS/Linux is post-MVP. Replace bash scripts with Node/TS; schedule via Windows Task Scheduler, not launchd/cron.
- **Node + TypeScript.** `bin/glean` is a Node CLI; all `lib/*` are `.ts`. Shell-out only for `git` and `gh`.
- **Base branch is explicit per-project** in `%USERPROFILE%\glean\config.json` (`project_path → base_branch`). No autodetection in MVP; missing entry → skip `draft-impl` for that project with a warning.
- **Heuristic-only ranking for MVP.** `est_value` from discovery-evidence signal strength; `est_tokens` from template + excerpt size × 1.3. No upfront `claude -p` triage pass unless rankings prove bad post-MVP.

## Files referenced in the spec but not yet created

`bin/glean` (Node CLI), `lib/discover-jsonl.ts`, `lib/discover-git.ts`, `lib/executor.ts`, `lib/prioritize.ts`, `templates/{draft-impl,draft-pr-reply,research-dossier,fetch-docs}.md`, `README.md`.

## Verification checklist (§8)

When something is implemented, the spec lists explicit acceptance tests: dry-run discovery, single-task execution under a 15-min budget, budget self-termination (`summary.json.reason == "wall-clock"`), STOP sentinel, rate-limit back-off via a mocked `claude` stub, and `glean discard` reversibility. Use these as the test plan rather than inventing new ones.

## Open questions deferred (§11)

Notion-MCP mirror of dossiers, Homebrew distribution, and whether `glean peek` becomes a registered hook type vs. a standalone bin — all explicitly deferred. Do not pre-decide these.
