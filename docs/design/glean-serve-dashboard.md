# Design: `glean serve` — local management dashboard

Status: Accepted (auto-approved per build-to-completion request, 2026-06-12)
Author: dashboard sub-project

## Problem

Glean's operation and output are only legible through one-shot CLI receipts
(`glean today` / `morning` / `peek` / `rate --list`) and by hand-reading
`~/glean/{state,logs,dossiers}`. There is no single place to *see* what the
drain did across runs and *act* on it (stop/resume, retry failed work, discard
or rate dossiers, toggle the schedule). The 2026-06-11 drain exposed two
defects that were invisible without grepping JSONL by hand:

1. 7 tasks failed on a session-limit `429` but were recorded in
   `budget.json.completed_task_ids` — permanently dedup-skipped, never retried.
2. A `STOP` sentinel was left set, silently blocking every later tick.

A dashboard should make both states obvious and one-click fixable.

## Constraints (from CLAUDE.md / glean.md)

- Node + TypeScript, shell-out only for git/gh. No heavy deps.
- File-based state under `~/glean/`. Windows-first.
- Read-only against the user's checkouts; the only writes are to `~/glean/`.

## Approach (chosen)

**Built-in `http` server + one self-contained HTML page.** No Express, no
Vite, no framework, no build step. `src/lib/dashboard-html.ts` exports the page
as a string (compiles into `dist/`, ships via the existing `files` glob). The
page polls JSON API endpoints every few seconds and renders client-side.

Rejected: Express/React/Vite (new deps + build step, violates minimal-deps
ethos); a static one-shot HTML generator (no management actions — the whole
point).

### Security (load-bearing — this server can spawn processes & edit state)

- Bind **127.0.0.1 only**. Never `0.0.0.0`.
- **CSRF / DNS-rebinding guard**: every mutating `POST` must carry
  `X-Glean-Dashboard: 1` (a custom header a cross-site form cannot set without
  a CORS preflight we never grant) AND a `Host`/`Origin` that is loopback.
- **No path traversal**: API addresses runs/dossiers by id; the server builds
  filesystem paths itself and asserts the resolved path stays within
  `gleanRoot()`. No client-supplied absolute paths are read.
- **No stored XSS via dossier markdown**: dossier `OUT.md` is AI-generated over
  repo/session content (untrusted), and this origin holds full management
  power, so the client markdown renderer `esc()`s all text and whitelists link
  schemes (`http(s)`/`mailto`/`#`/`/` only — `javascript:`/`data:` collapse to
  `#`). A `javascript:` link would otherwise be a privilege-escalation XSS.

## Data model (reuse existing readers)

| View | Source | Reused function |
|------|--------|-----------------|
| Overview/health | `budget.json`, `STOP`, `RUN.lock`, schedule | `readDrainState`, `isStopRequested`, `acquireLock` probe, `scheduleStatus` |
| Runs list | `state/<run>/summary.json` | direct read (glob) |
| Run detail | `logs/<run>/orchestrator.log` + `state/<run>/candidates.json` | parse JSONL + `titleFor` |
| Task stream | `logs/<run>/<task>.jsonl` | direct read, last N events |
| Dossiers | `dossiers/<slug>/<date>/INDEX.md` + memory.db | `findTodayDossiers`, `Memory` |
| Dossier body | `OUT.md` | direct read |

## API

Read (GET): `/api/overview`, `/api/runs`, `/api/runs/:id`,
`/api/runs/:id/tasks/:taskId`, `/api/dossiers`, `/api/dossier?id=…`.

Manage (POST, guarded): `/api/stop`, `/api/resume`, `/api/run`,
`/api/runs/:id/retry-failed`, `/api/dossier/discard`, `/api/rate`,
`/api/schedule/enable`, `/api/schedule/disable`.

`retry-failed` is the bug-fix surfaced as an action: it reads the run's
orchestrator log for non-ok task ids, maps them to evidence hashes via
`candidates.json`, and removes those hashes from
`budget.json.completed_task_ids` so the next tick re-attempts them.

## UI

Status bar (always visible): state pill (running / idle / STOPPED), drain
window age + `unproductive_reentries` + `week_exhausted`, schedule next-run,
and action buttons (Run now, Stop/Resume). Health banners for the two known
defects. Three tabs: Overview, Runs (table → detail → task stream), Dossiers
(list → rendered OUT.md, with discard/rate).

## Out of scope (v1)

Auth/multi-user, websockets (polling is fine for a localhost tool), editing
config, draft-impl worktree diffing. Deferred to follow-ups.
