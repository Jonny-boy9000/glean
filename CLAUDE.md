# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

**v0.9.0 — "capacity governor" — prepped on branch `chore/full-review-improvements`** (npm still publicly at `@jonny-boy9000/glean@0.8.5` until the user publishes 0.9.0). This release bundles **v0.9 capacity-governor wave-1** — `glean usage` + the self-relative pacing engine (`src/lib/usage.ts` internal JSONL loader per ADR-0007, `src/lib/pacing.ts` per ADR-0005; `recommendTier()` is the wave-2 API), per-spawn model routing (ADR-0006) + `--max-turns` guards, the `discover-docs` 4th discovery pass, the project portfolio (`glean projects`), and the always-on dashboard (`glean serve install|uninstall|status`) — together with the **2026-06-22 full-project-review hardening**: `glean gc` no longer leaks `prep/glean-*` branches (UUID mis-parse), cross-day dedup no longer suppresses FAILED candidates, an IPv6-loopback dashboard host-check hole closed, PowerShell scheduled-task registration hardened against injection, `better-sqlite3` lazy-loaded (a missing binding no longer kills `glean version`/`doctor`), new `glean doctor` preflight, the `uuid` dep dropped, and `executor.ts` split into `executor.ts`+`spawn-claude.ts`+`draft-git.ts`+`draft-test.ts`. Built on **v0.8.5** (PRs #20–#23: project portfolio + cwd-based session matching + never-empty titles/unique dossier dirs + sleep-proof deadlines per ADR-0004) and **v0.8.4** (PRs #15–#19: `glean serve` dashboard, Linux beta, honest dedup + structured-429 per ADR-0003, dossier read-scope per ADR-0002). **739 tests + 7 skips.** Public repo at https://github.com/Jonny-boy9000/glean. See [`docs/PROJECT-MAP.md`](./docs/PROJECT-MAP.md) and the full review at [`docs/reviews/2026-06-21-full-project-review.md`](./docs/reviews/2026-06-21-full-project-review.md). **To pick up cold, read [`docs/handoff/post-v0.9.0-handoff.md`](./docs/handoff/post-v0.9.0-handoff.md).**

Done so far: the MVP + quality patches (v0.1.x), the persistent-memory + usefulness-telemetry loop (v0.2–v0.6: `glean today`/`rate`/`peek`, dossier sweep), the **`draft-impl` engine** (v0.7.0 — AI-drafts code for the top TODO into an isolated `git worktree` on a `prep/glean-*` branch; safety enforced by a scoped tool allow-list; `glean gc` for worktree expiry), the **`glean morning` receipt** with verified draft test status (v0.7.1), and the **v0.8.0 drain core** (`glean run --drain` exit-and-re-enter + `glean schedule` Windows Task Scheduler + rate-limit horizon classifier + window-aggregated morning receipt). Both make-or-break gates were cleared empirically before building (no headless `claude usage` query; `claude -p` authenticates under Task Scheduler). **v0.8.1 UX polish** adds a work-week-aware schedule default (timezone-detected: Thursday for Israel, else Friday), a durable shareable `RECEIPT.md` (`glean morning --md`), and a README rewritten to v0.8 reality.

**v0.9 capacity governor — wave-1 has LANDED** (in v0.9.0 above): `glean usage` + the pacing engine, per-spawn model routing (`--model sonnet` default — Sonnet has its own weekly pool on Max and burns the shared cap several times slower than Opus), `--max-turns` guards, the `discover-docs` pass, the project portfolio, and dashboard auto-start at logon are all built. **Wave-2 remains:** the nightly schedule preset gated by `glean usage`'s pace tier (consumes `recommendTier()`), the morning anti-spill margin (end N hours before the typical first prompt), and utilization-aware admission control. Design: [`docs/design/2026-06-12-capacity-governor-strategy.md`](./docs/design/2026-06-12-capacity-governor-strategy.md) (adversarially reviewed; the pacing math is pinned in its "Pacing definition" section). For "what's next" see **[`docs/ROADMAP.md`](./docs/ROADMAP.md)** — the single source of truth for planned work. Update it on every release.

When asked to "build", "implement", or "continue" something:
1. **Read `docs/ROADMAP.md` first** to see what's in the "Up next" queue and what's already been deferred indefinitely.
2. **Read `docs/PROJECT-MAP.md`** — the index of *where everything lives*, including the parts **not in this repo** (the machine-local gstack design docs at `%USERPROFILE%\.gstack\projects\Jonny-boy9000-glean\` and the `~/glean` runtime output). Keep it current: any time you add/move/delete a file or change its responsibility, update PROJECT-MAP.md in the same change (it has a "How to keep this map current" section).
3. Then read `glean.md` (the broader vision) and the relevant spec under `docs/superpowers/specs/` for context.
4. Specs are the source of truth for *what* a release did; the roadmap is the source of truth for *what's coming*.

## What `glean` is

A local CLI (`glean`) that consumes idle Claude Pro/Max subscription capacity at the tail of the weekly rate-limit window. It scans the user's `~/.claude/projects/*.jsonl` session history and their git repos for unfinished work, then spawns headless `claude -p` sessions to produce speculative drafts, research dossiers, and pre-fetched docs into `~/glean/`. The next session, the user opens a "prep folder" and finds a head-start.

It is **not** an API-token reseller or marketplace — that alternative was explicitly dropped (see `glean.md` §2) because Anthropic's terms prohibit reselling/proxying Claude access.

## Decision records & assumptions

Load-bearing decisions — and especially **unverified assumptions** — are recorded as tiny ADRs in
[`docs/decisions/`](./docs/decisions/) and tagged at the code site (`ASSUMPTION[ADR-NNNN]` /
`INVARIANT[ADR-NNNN]`). This exists because rationale stated as *fact* (in a comment or memory)
once led a later session to "correct" a subsystem wrongly — the fix is to mark **verified vs.
assumed, loudly, where the code is**. Rules:

- Touching a subsystem with an `ASSUMPTION[ADR-NNNN]` tag? **Read that ADR first.** It tells you
  what's a guess and what would change it.
- Making a load-bearing or unverified decision, or reversing one? **Add/supersede an ADR** (never
  edit an old one; supersede it) and tag the code site. See `docs/decisions/README.md`.
- **A finding that overturns a prior decision is a hypothesis to disprove, not a conclusion** —
  verify the negative case before asserting (evidence before assertions). The rate-limit signal
  (ADR-0001) is the worked example: a "real signal found!" claim was a warning, not the block.

## Load-bearing constraints (do not violate)

- **Subscription auth, no API key.** Capacity is consumed by spawning `claude -p "<prompt>"` subprocesses. Never introduce direct Anthropic API calls or `ANTHROPIC_API_KEY` usage — the whole tool assumes Pro/Max session auth.
- **Read-only against the user's primary checkouts.** All speculative output goes to `git worktree`-based `prep/*` branches under `~/glean/work/` or to dossier dirs under `~/glean/dossiers/`. Never mutate the user's main checkout or push anything.
- **Spawned sessions must run with a deny-list.** Every `claude -p` invocation passes `--disallowedTools "Bash(git push:*) Bash(git checkout main:*) Bash(gh pr merge:*) Bash(gh pr create:*)"`. Do not remove these even if a task seems to need them.
- **No cross-invocation prompt caching.** Subscription auth can't manage `cache_control`; only in-session caching inside one `claude -p` call is free. Don't design around a pre-warmed cache.
- **Rate-limit budget is indirect.** There is no separate headless `claude usage` probe (Spike 0). The executor reacts to a wall-clock `--budget`, a `~/glean/STOP` sentinel, and a rate-limit signal. **Correction (2026-06-02):** the real `claude -p` rate-limit signal is **not** stderr prose — it is a structured `{"type":"rate_limit_event","rate_limit_info":{…}}` message in the `--output-format stream-json` stream glean already captures to `~/glean/logs/<run>/<task>.jsonl` (carries `rateLimitType` e.g. `five_hour`, `resetsAt` epoch-seconds, `status` incl. a proactive `allowed_warning` + `utilization`). Classify off that; keep the stderr regex as a fallback. See [`docs/open-work/06-rate-limit-signal-findings.md`](./docs/open-work/06-rate-limit-signal-findings.md). Still don't invent a token-counter abstraction.
- **Default `max_parallel=1`.** Subscription sessions share one rate-limit bucket, so parallelism mostly accelerates exhaustion. `--parallel 2` is exposed but is not the default.

## Architecture pointers (read `glean.md` for detail)

- **§5.1 Discovery** — parallel read-only passes: JSONL session signals, git scan (`git grep TODO/FIXME`, stale `claude/*` branches, `gh pr list`), `find -mtime -7`, plus the v0.9 `discover-docs` pass mining the project's own planning docs (ROADMAP/TODO/handoff "up next" items) as candidates. Emits `candidates.json`.
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

## Codebase layout (post-v0.1.2)

All the files originally listed as "not yet created" now exist on `main`:

- `bin/glean.js` — thin shim, dispatches to `dist/cli.js`
- `src/cli.ts` — citty CLI with `run`/`stop`/`repair`/`version` subcommands
- `src/lib/{types,config,state,render,dedup,prioritize,discover-jsonl,discover-git,discover-deps,jobobject,executor,jsonl-extract,repair,pipeline}.ts` — one responsibility per file
- `templates/{research-dossier,fetch-docs}.md` — bundled prompt templates
- `test/fixtures/` — fake-claude stub + JSONL session fixtures
- `test/integration/v01-…v12-….test.ts` — verification-row integration tests

The `draft-impl` and `draft-pr-reply` templates from the original spec list are NOT yet built — those land with the `draft-impl` sub-project (see ROADMAP.md "Deferred sub-projects").

## Verification checklist (§8)

When something is implemented, the spec lists explicit acceptance tests: dry-run discovery, single-task execution under a 15-min budget, budget self-termination (`summary.json.reason == "wall-clock"`), STOP sentinel, rate-limit back-off via a mocked `claude` stub, and `glean discard` reversibility. Use these as the test plan rather than inventing new ones.

## Open questions deferred (§11)

Notion-MCP mirror of dossiers, Homebrew distribution, and whether `glean peek` becomes a registered hook type vs. a standalone bin — all explicitly deferred. Do not pre-decide these.
