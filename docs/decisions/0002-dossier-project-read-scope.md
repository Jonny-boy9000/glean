# ADR-0002: Research-dossier sessions get read-scope to the project (not just the output dir)

**Status:** Accepted (2026-06-12) — validated empirically by the 2026-06-11 live drain: 9/16 dossiers were genuinely repo-grounded, vs 8/13 explicit filename-guesses in the pre-fix 2026-06-04 drain.
**Supersedes:** none
**Related:** ADR-0001 (rate-limit signal source), CLAUDE.md "Load-bearing constraints"

## Context

The first unattended weekend drain (scheduled run `2026-06-04-1800-fe1ff9`, 13
research-dossier tasks, 0 failed) ran end-to-end, but the **dossiers it produced
are filename-based guesses, not research.** 8 of 13 `OUT.md` files explicitly say
so, e.g.:

> I could not read any file *contents* under `C:\Glean` — every `Read`/`Grep`/`Bash`
> against those paths was denied for lack of a permission grant; only directory
> enumeration (`Glob`) succeeded.

### Root cause

`src/lib/executor.ts:194-199` spawns the research-dossier `claude -p` with:

```ts
const spawn = await runClaude(c, ctx, {
  prompt,
  cwd: workDir,        // ~/glean/dossiers/<slug>/<date>/research-<task>/
  addDir: workDir,     // <-- the ONLY allowed directory
  deny: BASE_DENY,
  allowedTools: undefined,
});
```

`runClaude` (executor.ts:713-719) turns `addDir` into a single `--add-dir`. Because
the spawned session runs headless (`-p`) with no interactive user to approve a
permission prompt, every `Read`/`Grep`/`Bash` against the project path
(`c.project_path`, e.g. `C:\Glean`) — which is **outside** the one allowed
directory — is denied. The session can only enumerate names via `Glob`.

The template (`templates/research-dossier.md`) already instructs *"Read freely;
write only OUT.md"* and asks for *"observations from reading the code"* — so reading
the repo was always the intent. The spawn simply never granted it. This is a
plumbing gap, not a design choice.

This is the same class of finding as the v0.8.2 fetch-docs limitation (ROADMAP
"Hygiene / small fixes": fetch-docs can't reach doc tools under the deny-list), but
it hits the **primary** candidate type, so it is the load-bearing defect in the
"does the engine produce something you'd open?" question.

## Decision

Grant research-dossier (and fetch-docs `docs`) spawned sessions **read access to
the candidate's `project_path`**, while keeping the spawned session unable to
**write** anything into the project. Concretely:

1. Pass the project path as an additional `--add-dir` (variadic; verified
   `claude --help` shows `--add-dir <directories...>`).
2. Make the research-dossier spawn **write-incapable** with a **scoped read-only
   allow-list**, mirroring the draft-impl CRITICAL-1 posture in `deny.ts`:
   `allowedTools = Read Grep Glob` + a read-only Bash verb set
   (`git log` / `git diff` / `git show` / `git status`, `rg`). **No bare `Bash`,
   no `Edit`/`Write`/`NotebookEdit`.** The session reads the repo and emits the
   dossier as its **final assistant message**; glean (the orchestrator, not the
   session) writes `OUT.md` from the captured stream via a hardened
   `extractLastAssistantText`.

## Why this does not violate the safety invariant

CLAUDE.md's load-bearing constraint is **"Read-only against the user's primary
checkouts ... Never mutate the user's main checkout or push anything."** The
invariant is about *writes and pushes*, not *reads*. Granting read scope is what
makes the intended read-only research possible.

`--add-dir` grants read **and** write within a directory, and the spawn runs
`--permission-mode acceptEdits` (executor.ts:719). So adding the project to
`--add-dir` **without** also removing write capability would let a speculative
session mutate `C:\Glean`.

**A deny-list cannot close this hole** (the key correction from the
2026-06-06 eng review). The dossier spawn currently passes `allowedTools:
undefined` (executor.ts:199) = **bare `Bash` granted**. `deny.ts:38-45` already
documents why that is unsafe: bare `Bash` lets the model run
`echo x > <main>/file` or `rm -rf <main>`, "none of which a prefix deny-list can
fully block." So denying `Edit`/`Write`/`NotebookEdit` (the original plan) would
**not** prevent project mutation via Bash.

The decision therefore uses an **allow-list** (default-deny), the same shape
draft-impl proved: the only tools the session can use are read tools and a fixed
read-only Bash verb set, so project mutation is **mechanically impossible**, not
merely discouraged by the prompt. We do not rely on model goodwill for the safety
property.

## Assumptions (verify before/at implementation) — `ASSUMPTION[ADR-0002]`

- **A1:** `claude -p` honors multiple `--add-dir` values and grants non-interactive
  read access to all of them. (Help text supports variadic; behavior to be
  confirmed by a one-task run.)
- **A2:** With `Edit`/`Write`/`NotebookEdit` denied, a read-only session still
  produces a complete dossier as its final message, and the hardened
  `extractLastAssistantText` captures it without truncation.
- **A3:** Denying the Write/Edit tools does **not** also break the session's ability
  to do read-only `Bash` (e.g. `git log`, `rg`). If it does, scope the deny to
  Edit/Write/NotebookEdit only and leave Bash governed by `BASE_DENY`.

If A1 is false, fall back to Approach 2 (keep `OUT.md` writing, path-scope `Write`/
`Edit` to `workDir` via `--disallowedTools`) and supersede this ADR with the
verified mechanism.

## Consequences

- Dossiers become real research grounded in the repo, directly improving the
  "would I open this?" signal the roadmap is trying to measure.
- One more reason the BLOCK-CAPTURE / ADR-0001 chase is **not** the top priority:
  even a perfect rate-limit classifier over blindfolded dossiers produces nothing
  worth keeping. ADR-0001 is demoted from "the #1 gate" to "harden when it trips."
- A read-only-by-construction spawn is a cleaner safety story than the prior
  "one writable dir + trust the prompt" posture.

## What would reverse this

- If `claude -p` cannot be made write-incapable while read-capable on the project,
  revert to output-dir-only scope and accept that dossiers are structural-only
  (and relabel the candidate type to set expectations).
