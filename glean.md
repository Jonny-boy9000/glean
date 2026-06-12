# Glean

**Quiet work between sessions.** Use idle Claude Pro/Max capacity for speculative prep work on your own projects.

> *gleaning* (n.) — the practice of gathering leftover crops from the field after the main harvest. Glean does the same with unused capacity at the tail of your weekly rate-limit window.

Status: **shipped** — v0.8.3 on npm (`@jonny-boy9000/glean`), Windows-first, drain validated live. This document is the *vision/design rationale*, not the status page: current state lives in [CLAUDE.md](./CLAUDE.md) §Project state; what's next lives in [docs/ROADMAP.md](./docs/ROADMAP.md).
Author: yonijhw@gmail.com
Last updated: 2026-06-12 (status header only; design body is the 2026-05-23 original)
CLI: `glean`

---

## 0. Resolved decisions (2026-05-23)

These supersede any conflicting language elsewhere in the doc.

- **OS target:** Windows-first. Development happens on Windows 11 (`C:\Glean`). macOS/Linux ports are post-MVP. References to bash scripts (`lib/discover-git.sh`, `lib/executor.sh`) are replaced with Node/TS modules; `launchd`/cron scheduling is deferred and replaced by Windows Task Scheduler for the schedule MVP.
- **Language:** Node + TypeScript. `bin/glean` is a Node CLI; `lib/*` are `.ts` files. No Python, no Bash core. Shell-out only for `git` and `gh` subprocess calls.
- **Base branch resolution:** per-project, explicit. `~/glean/config.json` (or `%USERPROFILE%\glean\config.json` on Windows) maps `project_path → base_branch`. No autodetection in MVP. Missing entry → skip `draft-impl` candidates for that project with a warning.
- **`est_value` / `est_tokens` for MVP:** pure heuristics from discovery evidence. `est_value` = weighted sum of signal strength (TODO count, branch staleness in days, PR comment count, file recency); `est_tokens` = template size + evidence excerpt size × 1.3. No upfront `claude -p` triage pass in MVP. If post-MVP ranking proves unreliable, swap in a triage pass; otherwise keep heuristics.

---

## 1. The idea in one paragraph

You're on a Claude Pro/Max subscription. The weekly rate-limit window resets Saturday morning. By Thursday and Friday you've often spent the high-value work and have unused capacity that **doesn't roll over**. `glean` is a local CLI tool that, during that idle tail-window, spawns its own Claude Code sessions to do *speculative* prep work on your existing projects — drafting code in throwaway git worktrees, writing research dossiers, pre-fetching library docs. The following week you open a "prep folder" and find a head-start. Even 30–50% useful output is a meaningful save of next week's capacity.

## 2. What we are explicitly NOT building

The original alternative idea — an MCP that resells leftover tokens to a third-party marketplace — is **dropped**.

- Anthropic's Usage Policies and Commercial Terms prohibit reselling or proxying Claude API access. Building such a product risks account termination.
- Subscription capacity is not a transferable token bank; there is nothing concrete to resell.
- Even if technically possible, the marketplace problem (matching, payments, abuse, fraud) is far larger than the AI problem.

We are only building the local prep-work tool.

## 3. Research summary

Surveyed adjacent and overlapping tools to confirm this is worth building fresh.

| Tool | Match | Why it's not enough |
|---|---|---|
| Cursor Background Agents | Closest in vision | Cloud-hosted, proprietary, no budget/idle-window awareness |
| Sweep AI | Adjacent | GitHub-issue → PR only; no session-history scanning |
| Aider watch mode | Adjacent | Good comment-marker pattern; no capacity management |
| Claude Code `run_in_background` + hooks | Substrate | Primitives only, no scanning or prioritization |
| Git worktree + AI patterns | Substrate | Adopt as sandboxing primitive |
| `ruvnet/ruflo` | Heavyweight orchestrator | See §10 — overkill for this tool |

**Verdict:** build fresh on local primitives we know exist. See §10 for the dev-substrate decision.

## 4. Decided constraints

- **Local machine only.** Reads `~/.claude/projects/<dash-encoded-cwd>/<session>.jsonl` and the user's git repos directly. Cloud sessions can't see your real session history.
- **Pro/Max subscription, no API key.** Spare capacity is consumed by spawning `claude -p "<prompt>"` headless sessions. No direct API calls.
- **Pre-warmed API prompt caches are NOT viable** on subscription auth (no `cache_control` block management). In-session caching inside each `claude -p` invocation still happens for free.
- **Read-only against original projects.** All speculative output lives in git worktrees on disposable `prep/*` branches, or under `~/glean/dossiers/...`. Never modifies primary checkouts.
- **Trigger: manual command + opt-in schedule (off by default).**

### Output priority (highest leverage first)

1. **Draft code** in git worktrees
2. **Markdown dossiers** — research notes, design docs, PR-response drafts
3. **Pre-fetched docs** — library docs via context7-style MCP, cheap filler when bigger work is exhausted
4. ~~Pre-warmed prompt caches~~ — skipped, API-only

## 5. Architecture

### 5.1 Discovery pass (read-only)

A single orchestrator script emits `~/glean/state/<run-id>/candidates.json`. Three parallel sources:

**JSONL session history** at `~/.claude/projects/<dash-encoded-cwd>/<session>.jsonl`. Signals for an unfinished thread:

- Last record is a `tool_use` block with no matching `tool_result` — session ended mid-action.
- Last user turn contains "TODO", "later", "I'll", "remind me".
- Session opened in `permissionMode: "plan"` and never re-entered.
- `aiTitle` substring matches a TODO/FIXME in the repo at `cwd`.
- More than 10 assistant turns, idle >24h, branch not stale.

**Git scan per project** (`git -C <cwd>`):

- Stale `claude/*` branches with commits ahead of base.
- `git log --since=14.days` to weight recent work.
- `git grep -nE '(TODO|FIXME|XXX|HACK)\b'`, capped at 200 hits/repo.
- `gh pr list --author @me --state open` + unresolved review threads.
- `git worktree list` to avoid stomping existing worktrees.

**File recency** — `find -mtime -7` excluding `node_modules` and build dirs.

**Candidate record shape:**

```json
{
  "id": "<uuid>",
  "project_path": "/abs/path",
  "type": "draft-impl | draft-pr-reply | research-dossier | fetch-docs",
  "evidence": { "session_id": "...", "branch": "...", "pr_number": 0, "files": [], "todo_lines": [] },
  "prompt_seed": "...",
  "est_value": 75,
  "est_tokens": 12000,
  "blocked_by": []
}
```

### 5.2 Prioritizer + budgeter

Rank by `est_value / log(est_tokens + 1)` with type-weighted floors enforcing the user's priority order:

| Type | Weight |
|---|---|
| `draft-impl` | 1.0 |
| `draft-pr-reply` | 0.9 |
| `research-dossier` | 0.7 |
| `fetch-docs` | 0.2 |

When `<30 min` remain in budget, only `fetch-docs` candidates are eligible — cheap filler at the end.

**Indirect budget tracking** (no API token endpoint on subscription):

- Wall-clock budget: `--budget 3h` default.
- Per-task timeout: 8 min, kills `claude -p` via SIGTERM if exceeded.
- Rate-limit detection: parse `claude -p` stderr for `rate limit`, `429`, `usage limit`, `5-hour limit`, plus any remaining-window hints `claude` prints.
- Back-off on hit: `60s, 300s, 900s, 1800s`. Three hits in a 30-min window trips a circuit breaker; state persisted to `state/budget.json`.
- Hard stops: circuit open, budget exhausted, `~/glean/STOP` sentinel present, `--until "Sat 05:00 local"` reached.
- Default `max_parallel=1`. Subscription sessions share one rate-limit bucket, so parallelism mostly accelerates exhaustion. `--parallel 2` exposed for users who want to risk it.

### 5.3 Executor

Per candidate:

1. **Workspace.** For `draft-impl`: `git worktree add -b prep/<slug>-<runid> ~/glean/work/<proj>-<slug> <base-branch>`. Others: dossier dir under `~/glean/dossiers/<proj>/<date>/<slug>/`.
2. **Prompt** rendered from `~/glean/templates/<type>.md` with evidence + file excerpts (≤200 lines each) + a fixed footer: *"speculative — produce a draft, never push, write findings to `OUT.md`."*
3. **Invocation:**

   ```bash
   cd <work-or-dossier-dir> && claude -p "$(cat prompt.md)" \
     --output-format stream-json --include-partial-messages \
     --add-dir <dir> \
     --permission-mode acceptEdits \
     --disallowedTools "Bash(git push:*) Bash(git checkout main:*) Bash(gh pr merge:*) Bash(gh pr create:*)" \
     --session-id <uuid> \
     > ~/glean/logs/<run-id>/<task-id>.jsonl 2> .../<task-id>.stderr
   ```

4. **Capture.**
   - `draft-impl`: auto-commit speculative diff `[prep] speculative: <title>`. If empty, mark `empty=true`.
   - Other types: expect `OUT.md`; if missing, dump last assistant text from stream-json log.
5. **`fetch-docs`** uses a context7-style MCP (`resolve-library-id` → `query-docs`) to write `docs/<lib>.md`.

### 5.4 Dossier layout

```
~/glean/
  dossiers/<proj>/<YYYY-MM-DD>/
    INDEX.md                          # sorted by realized value
    01-draft-impl-<slug>/             # symlink to worktree + OUT.md abstract
    02-pr-reply-<pr#>-<slug>/OUT.md
    03-research-<slug>/OUT.md
    99-docs/<lib>.md
  work/<proj>-<slug>/                 # git worktrees, branch prep/<slug>-<runid>
  logs/<run-id>/{orchestrator.log, <task-id>.jsonl, <task-id>.stderr, summary.json}
  state/<run-id>/{candidates.json, budget.json, results.json}
  templates/{draft-impl,draft-pr-reply,research-dossier,fetch-docs}.md
```

`INDEX.md` per entry contains: title, type, est. value, evidence link, **Apply hint** (`git -C <repo> merge prep/<slug>-<runid>` or `cherry-pick`), **Discard hint** (`glean discard <task-id>`), 3-line abstract pulled from `OUT.md`.

### 5.5 Scheduling

**Manual:**

```
glean run [--budget 3h] [--projects auto|<path>...] [--until "Sat 05:00"] [--dry-run]
```

`auto` decodes every directory under `~/.claude/projects/` back to a real path that still exists as a git repo.

**Schedule (off by default):**

```
glean schedule enable|disable|status
```

- macOS: writes `~/Library/LaunchAgents/com.glean.weekly.plist` with `StartCalendarInterval` Thu 18:00.
- Linux: writes a crontab line `0 18 * * 4 /usr/local/bin/glean run --until "Sat 05:00"`.

**SessionStart hook (opt-in):**

Runs `glean peek --cwd "$CLAUDE_PROJECT_DIR"`, prints the latest dossier `INDEX.md` for the project (silent if none). Pattern reference: the existing `session-start-hook` skill.

### 5.6 Safety + reversibility

- **Branch isolation.** `--disallowedTools` blocks `git push`, `git checkout main|master`, `gh pr merge`, `gh pr create`. All speculative branches namespaced `prep/*` and committed only inside `~/glean/work/*` worktrees — never the user's primary checkout.
- **One-command discard.** `glean discard <run-id|task-id|--all-older-than 14d>` removes worktree, deletes `prep/*` branch, `rm -rf`s the dossier dir.
- **GC.** Weekly `glean gc`. Worktrees auto-expire 21 days unless `INDEX.md` marks them `kept`.
- **STOP sentinel.** `glean stop` writes `~/glean/STOP`; orchestrator checks between every task and after every assistant turn.
- **Postmortem.** `summary.json` records wall-clock used, rate-limit hits, circuit state, candidates skipped/run/failed.

## 6. MVP first slice (one weekend)

Smallest end-to-end version that proves the concept:

- Manual trigger only — no schedule, no hooks.
- Single project (`--project <path>`), 60-min budget.
- Discovery limited to JSONL last-`aiTitle` + `git grep TODO/FIXME` + `gh pr list`.
- Candidate types limited to `research-dossier` and `fetch-docs` (no worktree drafting yet).
- Serial executor with 8-min per-task timeout; exits cleanly on rate-limit stderr.
- Writes `INDEX.md` + per-task `OUT.md`. Discard is manual `rm -rf` of the date dir.

~600–900 LOC. Testable on this machine against `~/.claude/projects/-home-user-Testing/`.

## 7. Files to create

| Path | Purpose |
|---|---|
| `bin/glean` | Orchestrator entrypoint (`run`, `stop`, `peek`, `discard`, `gc`, `schedule`) |
| `lib/discover-jsonl.{js,py}` | Parses `~/.claude/projects/*/*.jsonl` |
| `lib/discover-git.sh` | `git grep`, branch scan, `gh pr list` |
| `lib/executor.sh` | Wraps `claude -p` with timeout, deny-list, stream-json capture, rate-limit parsing |
| `lib/prioritize.{js,py}` | Ranking + budget gates |
| `templates/draft-impl.md` | Prompt template for code drafts |
| `templates/draft-pr-reply.md` | Prompt template for PR comment replies |
| `templates/research-dossier.md` | Prompt template for research notes |
| `templates/fetch-docs.md` | Prompt template for docs pre-fetch |
| `README.md` | `run`/`stop`/`discard` UX, schedule install instructions |

Reference only (do not edit): `~/.claude/skills/session-start-hook/SKILL.md` for the hook pattern.

## 8. Verification

1. **Dry-run discovery.** `glean run --project ~/some-repo --dry-run` prints a ranked candidate list with evidence and est. cost — no Claude invocations.
2. **Single-task execution.** `glean run --project ~/some-repo --budget 15m --only research-dossier` produces a real `OUT.md`. Inspect log under `~/glean/logs/<run-id>/`.
3. **Budget honored.** Start a run with `--budget 5m`; confirm self-termination + `summary.json` with `reason: "wall-clock"`.
4. **Stop sentinel.** Start a run, run `glean stop` in another shell; orchestrator exits between tasks within ~one task duration.
5. **Rate-limit simulation.** Inject `echo "rate limit" >&2` into a mocked `claude` stub; confirm back-off + circuit-breaker fire and persist in `state/budget.json`.
6. **Reversibility.** After a `draft-impl` run, `glean discard <task-id>` removes worktree + branch; `git worktree list` and `git branch | grep prep/` are clean.
7. **Hook (post-MVP).** Install SessionStart hook, `cd` into a repo with a dossier, open `claude`; INDEX prints once on startup.

## 9. Known caveats

- Pre-warmed API prompt caches across invocations are unavailable on subscription auth. In-session caching inside each `claude -p` invocation still happens for free.
- Rate-limit budget visibility is indirect — `claude` does not expose remaining-window programmatically on Pro/Max today, so the planner reacts to stderr signals rather than peeking at a counter.
- The orchestrator can be hosted inside an interactive Claude session via the `loop` skill if preferred over a bare shell process — same logic, driven by `/loop` instead of a `while` loop.

## 10. Development substrate decision: Ruflo vs. bare Claude Code CLI

You mentioned [`ruvnet/ruflo`](https://github.com/ruvnet/ruflo) is already set up. Here's the trade-off.

### What Ruflo offers

Multi-agent orchestration platform extending Claude Code with: 100+ specialized agents, swarm topologies, HNSW-indexed vector memory (AgentDB), 27 orchestration hooks, 12 auto-triggered background workers, ~210 MCP tools, federation across machines, PII filtering, multi-provider routing.

### What `glean` actually needs

A shell script that:

1. Reads JSONL files and grep output.
2. Spawns `claude -p` headless sessions with deny-lists.
3. Manages git worktrees.
4. Writes markdown to a directory.

That's it. No agent swarm, no vector memory, no federation, no PII redaction. The "intelligence" is delegated to the spawned `claude -p` sessions themselves.

### Recommendation: build bare, in the Claude Code CLI

**Use Claude Code CLI directly. Skip Ruflo for `glean` itself.** Reasons:

- **Substrate match.** The tool's runtime substrate *is* `claude -p` + git + shell. Developing in the CLI means dogfooding the exact primitives the tool ships on top of. Ruflo abstracts those away behind its router.
- **Dependency footprint.** Adding Ruflo means `glean` users need Ruflo installed. The whole point of `glean` is portable, minimal — a script you run on your own machine.
- **Conceptual overlap is misleading.** Ruflo's background workers run *during* a session for the current task. `glean` is the opposite: runs *between* sessions, drives entirely new sessions, on its own schedule. Different problem.
- **You'd be using ~5% of Ruflo's surface.** Vector memory, federation, AIDefence, swarm consensus — none of it applies. You'd be paying complexity tax for unused features.

### When Ruflo *could* help

Two narrow places where Ruflo's primitives *might* be useful:

1. **As an internal target for `glean`.** If your projects already use Ruflo, the `fetch-docs` and `research-dossier` outputs could be written into Ruflo's AgentDB so they're searchable from inside future Ruflo sessions. This is an *output integration*, not a dev dependency — slot it in after MVP.
2. **As a reference for hook patterns.** Ruflo's 27 orchestration hooks are a working example of hook composition. Read them for inspiration on the SessionStart hook design in §5.5.

### Recommended dev flow

1. Work in a terminal session of **Claude Code CLI** in this repo.
2. Use the **`loop` skill** (already installed) for any "build → test → iterate" cycles, *not* as the tool's runtime — just for development.
3. Use **git worktrees** during dev for parallel experiments — same primitive the tool will ship.
4. Skip plugins. The codebase is ~900 LOC; a plugin framework adds more weight than it saves.
5. **Do not use the desktop app for this.** The CLI exposes the shell environment the tool actually targets; the desktop app abstracts it.

## 11. Open questions for later

- Should dossiers be written as Notion pages (via the Notion MCP) in addition to local markdown, for mobile review on Monday morning?
- Worth distributing as a Homebrew formula, or stay as a `git clone` + `make install`?
- Should `glean peek` integrate with the existing `session-start-hook` skill as a registered hook type, or remain a standalone bin invoked from `settings.json`?

---

*Companion plan file (read-only reference): `~/.claude/plans/sometimes-when-using-claude-snazzy-chipmunk.md`*
