# Glean — Dossier read-access fix (design + plan)

**Date:** 2026-06-06
**Status:** DRAFT (plan-first; no code yet)
**ADR:** [ADR-0002](../../decisions/0002-dossier-project-read-scope.md)
**Originated:** first unattended weekend drain (`2026-06-04-1800-fe1ff9`) — see "Drain findings" below.

## Problem (one paragraph)

The scheduled weekend drain validated the **plumbing** (unattended trigger, 13 tasks,
0 failed, hourly re-entry, dedup, receipts) but exposed an empty **payload**: the
research-dossier `claude -p` sessions cannot read the project they research, so every
`OUT.md` is a filename-based guess (8 of 13 say so explicitly). Root cause:
`executor.ts:197` passes `addDir: workDir` (the dossier output dir) as the session's
only allowed directory; the project path is never granted, and a headless session has
no user to approve a read. This is the load-bearing defect behind "does the engine
produce something you'd open?" — and it makes the ADR-0001 / rate-limit-block chase
beside the point.

## Drain findings (evidence)

| Finding | Evidence | Severity |
|---|---|---|
| Dossiers can't read the repo | 8/13 `OUT.md` admit "could not read file contents / sandboxed to dossier dir"; `executor.ts:197 addDir: workDir` | **Blocker (this plan)** |
| Drain hits the work-floor, not the quota-ceiling | `summary.json reason:"completed"` after 37 min; `budget.json week_exhausted:false`; 6 hourly re-entries each `candidates_total:0, skipped_dedup:18` | High (reframes ROADMAP #1) |
| Discovery surfaces already-shipped work | candidates "Build v0.8.2 drain-robustness" (shipped), "Review PowerShell query fix" (shipped v0.8.3) | Medium (separate item) |
| Spawned sessions litter `.remember/` | every dossier dir has `.remember/logs/autonomous/save-*.log` from the `remember` plugin SessionStart hook firing inside `claude -p` | Medium (separate item) |
| Empty-title candidate → bare `research-/` dir | `dossiers/glean/2026-06-04/research-/` | Low (discovery edge case) |

This plan addresses **only** the blocker. The other rows are logged as follow-ups
(see "Out of scope / follow-ups").

## Recommended approach: read-only allow-list spawn, orchestrator-written OUT.md (Approach 1)

> **Eng-review correction (2026-06-06):** the original draft proposed denying
> `Edit`/`Write`/`NotebookEdit`. That is **insufficient** — the dossier spawn grants
> bare `Bash` (`executor.ts:199 allowedTools: undefined`), and `deny.ts:38-45`
> documents that bare `Bash` can write to the main checkout (`echo > file`, `rm`) in
> ways no prefix deny-list blocks. The corrected approach uses a **scoped read-only
> allow-list** (default-deny), the same posture draft-impl already uses.

Spawn research-dossier sessions with read access to the project and an allow-list
that grants only read tools, then have glean write `OUT.md` from the captured final
message.

### Changes

1. **`src/lib/deny.ts` — add a research read-only allow-list (new).**
   - `RESEARCH_READONLY_BASH_ALLOW = ['Bash(git log:*)', 'Bash(git diff:*)',
     'Bash(git show:*)', 'Bash(git status:*)', 'Bash(rg:*)']`.
   - `researchAllowedTools()` → `['Read', 'Grep', 'Glob', ...RESEARCH_READONLY_BASH_ALLOW].join(' ')`.
   - **No bare `Bash`, no `Edit`/`Write`/`NotebookEdit`.** `DRAFT_IMPL_*` constants
     stay untouched (regression guard).

2. **`src/lib/executor.ts` — `executeDossier` spawn opts (~line 194-199).**
   - Pass the project path as an additional read dir. Extend `runClaude` opts
     (executor.ts:698) so `addDir` accepts a list (or add `extraReadDirs: string[]`),
     and have the arg builder (executor.ts:718) emit
     `--add-dir <workDir> --add-dir <project_path>`.
   - For `research-dossier`, pass `allowedTools: researchAllowedTools()` (was
     `undefined`). Keep `deny: BASE_DENY` as defense-in-depth.
   - Keep `cwd: workDir` (harmless; nothing writes there now).

2. **`src/lib/jsonl-extract.ts` — harden `extractLastAssistantText`.**
   - Current impl returns only `content[0].text` of the last message. Change to:
     find the last `type:"assistant"` *message* (not a partial delta) and
     concatenate **all** its `content[].text` blocks, in order. Preserve the
     existing reverse-scan fallback and the `_(no output produced)_` sentinel.
   - This becomes the **primary** dossier source for research-dossier, so it must
     not truncate.

3. **`src/lib/executor.ts` — `executeDossier` capture (~line 240-252).**
   - For `research-dossier`, write `OUT.md` from `extractLastAssistantText(jsonlPath)`
     directly (today it's only the fallback when the session didn't write a file).
   - Leave the fetch-docs `docs` path's `findFirstFile(...\.md)` capture unchanged
     for now (fetch-docs is a separate roadmap item).

4. **`templates/research-dossier.md` — output contract.**
   - Change "Write `OUT.md` in the current working directory with these sections"
     to "Your **final message** must be the dossier with these sections" (same
     section list). Drop the "write only OUT.md" rule; the session is now read-only.
   - Keep the safety rules (no push, no checkout main, no PR mutation, speculative
     only).

### Why not Approach 2 (keep OUT.md write, path-scope writes to workDir)

`--add-dir` grants read+write; isolating "write workDir, read project" requires
`--disallowedTools "Write(...) Edit(...)"` path globs over Windows absolute paths,
which are fragile (wrong glob → either OUT.md write blocked or project write leaks).
Approach 1 makes project-write **mechanically impossible** and reuses capture code
glean already has. Adopt Approach 2 only if assumption A1 (multi `--add-dir`) fails.

## Test plan (TDD — write tests first)

Use the existing `test/fixtures/` fake-claude stub + integration harness.

1. **Arg-construction unit test (P1 safety proof):** `executeDossier` for a
   `research-dossier` candidate produces spawn args containing **both**
   `--add-dir <workDir>` and `--add-dir <project_path>`, AND `--allowedTools` equal
   to `researchAllowedTools()`, AND **no bare `Bash`** token and **no**
   `Edit`/`Write` in the allow-list. (Assert on the args passed to the spawn seam.)
2. **Allow-list shape test:** `researchAllowedTools()` contains `Read`/`Grep`/`Glob`
   and only the read-only Bash verbs; assert it does NOT contain `'Bash'` (bare),
   `'Edit'`, `'Write'`, `'NotebookEdit'`.
3. **Regression guard:** `draftImplAllowedTools()` / `DRAFT_IMPL_DENY` outputs are
   byte-for-byte unchanged (draft-impl MUST still write its worktree). Snapshot test.
4. **Extractor tests (becomes PRIMARY capture):** `extractLastAssistantText` over
   fixtures whose final assistant message has (a) **multiple** `content[].text`
   blocks → full concatenation in order; (b) **thinking + text** blocks → text only,
   thinking skipped; (c) **tool_use-only / empty** → sentinel; (d) missing file →
   sentinel. Also: a leading conversational preamble in the final message is
   acceptable (document the decision — do not silently strip).
5. **End-to-end capture test:** with the fake-claude stub emitting a multi-block
   final message and writing nothing, `executeDossier` produces an `OUT.md` equal to
   the concatenated message text.
6. **Live verification (manual, post-merge):** one real `glean run --project C:\Glean`
   restricted to a single research-dossier candidate; confirm the `OUT.md` cites
   real file contents (not "could not read"), and confirm `git status` in `C:\Glean`
   is clean afterward (no project mutation). This closes ADR-0002 assumptions A1-A3.

## Rollout

- Patch release **v0.8.4** (engine behavior fix; no API surface change).
- Update ADR-0002 Status → Accepted after live verification; record A1-A3 outcomes.
- ROADMAP: demote #1 (BLOCK-CAPTURE/ADR-0001 wait) below "payload quality"; add this
  as the new top engine item; note the drain reframe (work-floor vs quota-ceiling).

## Out of scope / follow-ups (log to ROADMAP, do not build here)

- **Stale candidate suppression:** discovery surfaces already-shipped work. Needs a
  "is this done?" signal (merged-commit match / recency / closed-PR) in
  `discover-jsonl` / `discover-git`. Separate design.
- **`.remember/` pollution in spawned sessions:** the `remember` plugin SessionStart
  hook runs as a shell hook inside `claude -p` (not via a denied tool, so the
  write-deny won't stop it). Fix by spawning with a minimal `--settings` / disabling
  plugins+hooks for spawned sessions. Separate, small.
- **Empty-title candidate → `research-/`:** guard `slugify`/title in discovery.
- **fetch-docs doc-tool access** (existing ROADMAP item): same family; decide grant
  vs relabel after this lands.

## Open questions

- Should fetch-docs get the same project read-scope in this change, or stay separate?
  (Plan keeps it separate to keep the diff small and the ADR focused.)
- Allow-list breadth: is `git log/diff/show/status` + `rg` enough read-only Bash, or
  does a dossier want more (e.g. `git blame`, `cat`)? Start minimal; widen only if the
  live run shows the dossier reaching for a denied read command.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found → resolved | 1 P1, 2 P2, 1 P3; P1 fixed in plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (backend) |

**Key finding (P1, confidence 9/10):** original plan's "deny Edit/Write/NotebookEdit"
did not close the bare-Bash write hole (`executor.ts:199` grants bare Bash;
`deny.ts:38-45` documents bare Bash can write to the main checkout). **Resolved:**
plan now uses a scoped read-only allow-list (`researchAllowedTools()` = Read/Grep/Glob
+ read-only git/rg), mirroring the draft-impl CRITICAL-1 posture. ADR-0002 and the
Changes/Tests sections updated accordingly.

**Other findings folded in:** stream-extraction is now the required capture path (P2);
allow-list chosen over deny-list completeness (P2); `runClaude` `addDir` becomes a list
(P3). Test plan expanded to 6 cases incl. the P1 arg-assertion safety proof and
extractor edge cases (thinking/tool_use/preamble).

**NOT in scope (deferred):** fetch-docs read-scope, stale-candidate suppression,
`.remember/` spawn pollution, empty-title guard — all logged as follow-ups above.

**UNRESOLVED:** none blocking. Two assumptions (ADR-0002 A1/A2: multi `--add-dir`
grants non-interactive read; read-only spawn yields a clean dossier via the hardened
extractor) close on the post-merge live run.

**VERDICT:** ENG CLEARED — ready to implement. CEO/Design reviews not required for a
backend safety fix.
