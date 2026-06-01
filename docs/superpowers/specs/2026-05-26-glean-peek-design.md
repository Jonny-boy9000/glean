# `glean peek` + SessionStart Hook Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-26
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Add a CWD-scoped `glean peek` CLI subcommand that walks up from the current directory to find the enclosing git repo, then prints just that project's today-dossier using the existing renderer. Silent exit (0) when there's nothing relevant — no errors, no warnings. Pairs with a Claude Code `SessionStart` hook (configured manually by the user) so dossiers auto-load into every new session's context. Ships as `v0.6.0`. Read-only; reuses v0.5.0's enriched today report unchanged.

---

## 1. Goal and success criteria

The strategic analysis on 2026-05-26 named compound-memory-across-sessions as the highest-leverage missing piece: dossiers exist as artifacts of prior thinking, but the next Claude session starts cold unless the user manually `cat`s them. `glean peek` closes that loop. When the user opens a new Claude session inside a repo with a recent dossier, the `SessionStart` hook runs `glean peek`, and the dossier lands in the session context automatically — no manual step.

Telemetry (v0.3.0 sweep + v0.4.0 ratings + v0.5.0 surfacing) is already in place, so `peek` can rely on the data being meaningful — you can validate which dossiers actually belong in your next session's context by reading the rating column. This release ships the read path; the validation is dogfood data going forward.

**Done when:**

1. New module `src/lib/peek.ts` exports `findPeekDossier(gleanRoot: string, cwd: string): TodayReport | null`. Three steps: walk up from `cwd` for a `.git` (file or directory), slug the repo root using the existing `projectSlug` convention, call existing `findTodayDossiers(gleanRoot)` and filter to the matching slug.
2. `findGitRoot(start: string): string | null` exists as an internal helper in `peek.ts`. Walks up via `dirname()` until either `.git` is found or the filesystem root is reached. Returns `null` if no `.git` found.
3. Existing `projectSlug` helper (currently duplicated in `pipeline.ts` and `executor.ts`) is extracted to `src/lib/state.ts` and exported. Both call sites updated to import from there. No new duplicate.
4. `src/cli.ts` registers `peekCmd`. Reads `process.cwd()` directly. Calls `findPeekDossier`. If `null`, exits 0 silently. Otherwise renders via the existing `renderToday(report, isTTY)` and writes to stdout + `\n`. Wraps everything in try/catch so any error path also exits 0 silently — never throw to the SessionStart hook.
5. New unit tests in `src/lib/peek.test.ts` cover the four documented scenarios. New integration tests in `test/integration/v17-peek.test.ts` spawn the CLI and assert behavior end-to-end.
6. `README.md` gains a 5-line section documenting the SessionStart hook config. `CHANGELOG.md` v0.6.0 entry includes the JSON snippet inline.
7. `npm test`, `npm run build`, `npm run lint` all exit 0. Total test suite: 136 + 1 skip → 143 + 1 skip.
8. `docs/ROADMAP.md` moves `glean peek` from Up next #1 to Done. Remaining Up next renumbered (#2 → #1).

## 2. Locked decisions (from brainstorm)

- **Project detection:** walk up from `process.cwd()` looking for a `.git` (file OR directory). Use `basename(repoRoot)` slugged via the existing `projectSlug` convention. Selected over CWD-basename (wrong for subdirs) and `--project` flag (YAGNI for v1).
- **Scope:** today only, single project (the one matching the current repo). No multi-day, no `--date`, no cross-project view (use `glean today` for that).
- **Output format:** identical to `glean today`. Reuses `renderToday` as-is — peek is `today` minus all-but-one project. Inherits v0.5.0's enrichment line automatically.
- **Failure mode:** exit 0 silent in ALL cases. No `.git`, no dossier, malformed memory.db, FS error, anything thrown — all collapse to "no output, exit 0". The hook contract requires this: a noisy peek would clutter every Claude session.
- **Hook installation:** manual user edit of `~/.claude/settings.json`. Documented in CHANGELOG + README with a copy-pasteable JSON snippet. No `--install-hook` flag in v0.6.0 (YAGNI — one user, one-time edit).
- **`projectSlug` extraction:** moved to `src/lib/state.ts` (currently has `gleanRoot()` and other path helpers — thematically right home). Both existing callers (`pipeline.ts`, `executor.ts`) updated. Net negative LOC.
- **Engine isolation:** no engine writes, no schema change, no interaction with discovery/prioritization/execution.
- **Version:** `v0.6.0` (minor — new CLI subcommand, no schema change).

## 3. Architecture

```
glean peek
  ├─ findPeekDossier(gleanRoot, process.cwd())
  │   ├─ findGitRoot(cwd) — walks up until .git found or filesystem root
  │   │     └─ returns null if no .git found
  │   ├─ projectSlug(repoRoot) — existing helper, now in state.ts
  │   ├─ findTodayDossiers(gleanRoot) — existing v0.5.0 scanner with enrichment
  │   └─ filter projects[] to matching slug; return null if no match
  ├─ if null → exit 0 silent
  ├─ renderToday(report, isTTY) — existing v0.5.0 renderer
  └─ stdout
```

The only new code is the walk-up + slug-filter logic. Everything else is reused unchanged. The minor refactor (extract `projectSlug` to `state.ts`) removes duplication that predates this release.

## 4. Module details

### 4.1 `src/lib/state.ts` — export `projectSlug`

Add to the existing `state.ts`:

```ts
import { basename } from 'node:path';

export function projectSlug(projectPath: string): string {
  return basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
```

Both existing inline definitions removed from `pipeline.ts` and `executor.ts`; both files import from `./state.js` instead. The behavior is identical (same regex, same `.toLowerCase()`, same `basename`).

### 4.2 `src/lib/peek.ts` — new module

```ts
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findTodayDossiers, type TodayReport } from './today.js';
import { projectSlug } from './state.js';

export function findGitRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;  // reached filesystem root
    dir = parent;
  }
}

export function findPeekDossier(gleanRoot: string, cwd: string): TodayReport | null {
  const repoRoot = findGitRoot(cwd);
  if (!repoRoot) return null;
  const slug = projectSlug(repoRoot);
  const all = findTodayDossiers(gleanRoot);
  const filtered = all.projects.filter((p) => p.project_slug === slug);
  if (filtered.length === 0) return null;
  return { date: all.date, projects: filtered };
}
```

Both functions exported (the inner helper too, so `peek.test.ts` can unit-test the walk-up in isolation).

### 4.3 `src/cli.ts` — `peekCmd`

```ts
import { findPeekDossier } from './lib/peek.js';
// renderToday and gleanRoot already imported

const peekCmd = defineCommand({
  meta: {
    name: 'peek',
    description: 'Print the current repo\'s today-dossier (CWD-scoped variant of `glean today`). Silent when nothing applies. Designed for SessionStart hook use.',
  },
  async run() {
    try {
      const report = findPeekDossier(gleanRoot(), process.cwd());
      if (report === null) return;  // exit 0, no output
      const useColor = Boolean(process.stdout.isTTY);
      process.stdout.write(renderToday(report, useColor) + '\n');
    } catch {
      // Silent: exit 0 no matter what. Hook commands must never break a session.
    }
  },
});
```

Register `peek: peekCmd` on the root command's `subCommands` map.

The outer try/catch is the failsafe. `findTodayDossiers` already swallows memory.db errors internally; this layer catches anything else (filesystem permission errors during walk-up, etc.) so the SessionStart hook always gets a clean exit 0.

### 4.4 SessionStart hook config (documented in CHANGELOG + README)

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

User merges this into `~/.claude/settings.json` (or the equivalent on their OS). Whatever `glean peek` writes to stdout becomes part of the session's `additionalContext`. Empty stdout = no context injection. No special escaping needed; the renderer's ANSI codes are stripped automatically because `process.stdout.isTTY` is false when stdout is piped to a hook.

## 5. Module changes

| File | Change |
|---|---|
| `src/lib/state.ts` | Export `projectSlug(path): string`. ~5 LOC delta. |
| `src/lib/pipeline.ts` | Remove inline `projectSlug`, import from `./state.js`. ~2 LOC delta (net delete). |
| `src/lib/executor.ts` | Same — remove inline, import. ~2 LOC delta (net delete). |
| `src/lib/peek.ts` | **New.** `findGitRoot` + `findPeekDossier`. ~30 LOC. |
| `src/lib/peek.test.ts` | **New.** 4 unit tests. ~90 LOC. |
| `src/cli.ts` | Add `peekCmd`, register on root. ~25 LOC delta. |
| `test/integration/v17-peek.test.ts` | **New.** 3 CLI tests. ~80 LOC. |
| `README.md` | Add a "Auto-load dossiers into Claude sessions" subsection with the JSON snippet. ~10 LOC. |
| `package.json` | Bump version to `0.6.0`. |
| `CHANGELOG.md` | v0.6.0 entry with hook config example inline. |
| `docs/ROADMAP.md` | Move peek to Done. Renumber Up next (#2 API-key fallback → #1). |

Estimated implementation LOC: ~60 (net, after the refactor savings). Tests: ~170.

## 6. Testing plan

### 6.1 `peek.test.ts` (4 unit tests)

1. **`findGitRoot` walks up and finds `.git`.** Create a temp dir, then `.git` inside it, then a nested subdir. Call `findGitRoot(nestedSubdir)`. Assert it returns the temp dir path.
2. **`findGitRoot` returns null when no `.git` exists.** Pass a temp dir with no `.git` anywhere up the chain. Returns null.
3. **`findPeekDossier` returns the matching project filtered.** Create `.git` in a temp repo. Create `~/glean/dossiers/<slug>/<today>/INDEX.md` under a separate temp gleanRoot. Call `findPeekDossier`. Assert returns `TodayReport` with exactly 1 project matching the slug.
4. **`findPeekDossier` returns null when no matching dossier OR no git.** Two sub-cases:
   - Has `.git` but no dossier dir → null.
   - Has dossier for other slug but not the current repo's slug → null.

### 6.2 `v17-peek.test.ts` (3 integration tests)

1. **Prints the dossier when in a git repo with a matching today's INDEX.** Spawn `glean peek` from inside a temp git repo with a fixture INDEX. Assert stdout contains expected content (project slug, entry title), exit 0.
2. **Empty stdout when not in a git repo.** Spawn `glean peek` from a temp dir with no `.git` anywhere up. Assert stdout is empty (or whitespace-only), exit 0.
3. **Empty stdout when no matching dossier.** Spawn from inside a temp git repo that has no dossier in the gleanRoot. Assert stdout empty, exit 0.

### 6.3 Regression discipline

All 136 existing tests must continue to pass. The `projectSlug` extraction is behaviorally identical and shouldn't break pipeline / executor tests. If any test fails because it imported `projectSlug` from `pipeline.ts` or `executor.ts` directly (unlikely — those were private), update the import. Run the full suite. Total target: 143 passing + 1 skipped.

## 7. Out of scope (explicit)

- **No `--install-hook` flag** that writes to `~/.claude/settings.json` automatically. Manual edit, documented.
- **No `--print-hook-config` flag.** The snippet is in CHANGELOG + README — just copy it from there.
- **No `--project <path>` override.** Walks up from CWD only.
- **No multi-day or `--date` flag.** Today only, same as `glean today`.
- **No format flag** (`--brief`, `--full`). Single output mode, identical to `glean today`.
- **No telemetry on peek invocations.** SessionStart hooks fire frequently; no need to count.
- **No interaction with writes** (`glean rate`, sweep, etc.). Pure read.
- **No new ranker behavior** even though peek now lands dossiers in next-session context. The ranker still uses heuristics; learning loops are future work.
- **No monorepo subproject detection** (e.g., walking up to `.git` finds the monorepo root, but the user ran `glean run --project /repo/packages/foo` so the dossier is under slug `foo` not `repo`). Known edge case; user can `cd` to the path they used for run, or wait for the deferred `--project` flag.

## 8. Rollback / failure modes

The contract is: **`glean peek` exits 0 silent in every conceivable failure mode.** SessionStart hook commands that error out can break or warn the user's session — unacceptable for an opt-in convenience.

- **CWD has no `.git` walking up to filesystem root** → `findGitRoot` returns null → peek exits 0 silent.
- **`existsSync` on `.git` throws** (permission error somewhere up the chain) → caught by the outer try/catch in `cli.ts` → exit 0 silent.
- **`memory.db` is missing/unreadable** → `findTodayDossiers` already degrades silently per v0.5.0's contract. Peek renders without enrichment.
- **No dossiers at all** → `findTodayDossiers` returns `{projects: []}` → filter returns `[]` → `findPeekDossier` returns null → silent exit.
- **Render throws** (unlikely with the current pure formatter) → outer try/catch → silent exit.
- **`process.cwd()` throws** (deleted-while-running edge case) → outer try/catch → silent exit.
- **User wants to disable peek** → remove the hook config from `~/.claude/settings.json`. No CLI flag to disable from inside glean.

## 9. Open questions deferred

- **Whether to ship `--install-hook`** as a convenience. Probably worth it once outside users start adopting; YAGNI for now.
- **Whether peek should accept `--project` for explicit override.** Useful when the user wants to inspect a project from outside its repo dir; deferred until needed.
- **Whether to detect monorepo subprojects** smartly (look for the deepest matching slug, not just the git root). Adds complexity; defer until it bites.
- **Whether peek should emit a marker line** like `<!-- glean-peek -->` so downstream tooling can grep. Premature.
- **Whether to gate on a max age** (e.g., only show dossiers <24h old, not yesterday's that lingered overnight). The today-only scope already enforces "today's calendar day"; revisit if dawn-of-day flakiness becomes an issue.

## 10. Release

`v0.6.0`. Minor bump for the new subcommand. CHANGELOG entry contains the hook-config JSON snippet for immediate copy-paste. README gets a new subsection (probably under an existing "Usage" or "Integrations" header — implementer chooses the natural place).
