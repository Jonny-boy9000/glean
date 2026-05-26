# `glean rate` — Active Usefulness Telemetry Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-26
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Add a `glean rate` CLI subcommand that writes explicit user ratings (`kept` / `discarded` / `actioned`) to a new `user_rating` column in `memory.db`, plus a `glean rate --list` flag that prints recent ratable dossiers so the user can find what to rate. Pairs with the v0.3.0 passive sweep: together they form the active + passive halves of dossier-quality measurement. Ships as `v0.4.0`. No engine behavior change.

---

## 1. Goal and success criteria

The v0.3.0 sweep captures a passive signal — "did the dossier file still exist after 7 days." That's noisy (the user might `keep` a file they never opened) and slow (7-day latency). `glean rate` adds the explicit, immediate ground truth: an active verdict from the user, applied in 5 seconds after they look at a dossier.

The two telemetry types are complementary, not redundant. Passive = "what did the user actually do with the file?" (default behavior). Active = "what did the user explicitly judge?" (deliberate verdict). The eventual ranker (separate sub-project) will combine both.

The ergonomics gap is the existential question for THIS feature: if the user can't easily find the dossier to rate, the feature dies in dogfood. So `glean rate --list` ships in the same release as the write path — the user gets a self-contained discovery + rating workflow without depending on Up next #2 (`glean today` enriched with memory.db).

**Done when:**

1. Schema migration `v3` adds two columns to `candidates`: `user_rating TEXT` (NULL when unrated; otherwise one of `'kept' | 'discarded' | 'actioned'`) and `user_rating_at INTEGER` (unix ms when the latest rating was applied). Sets `PRAGMA user_version = 3`. Applies idempotently against fresh, v1, and v2 DBs.
2. New `Memory` method `setUserRating(candidateId, rating): { updated: boolean; title: string | null }`. Returns `{updated: true, title}` on success, `{updated: false, title: null}` when no row matches. NOT write-once — ratings are mutable. The latest rating overwrites.
3. New `Memory` method `listRecentRatableCandidates(limit: number): Array<{...}>`. Returns rows where `outcome IS NOT NULL` AND `dossier_path IS NOT NULL`, sorted by `ended_at DESC`, limited to `limit` rows.
4. New module `src/lib/rate.ts` exports `renderRateList(rows, useColor): string` — pure formatter following the same ANSI-on-TTY pattern as `render-today.ts`.
5. New `glean rate` CLI subcommand in `src/cli.ts`. Two paths:
   - `glean rate --list` → calls `listRecentRatableCandidates(20)`, renders, prints.
   - `glean rate <id> <verdict>` → validates inputs, calls `setUserRating`, prints confirmation or error.
6. Validation: invalid id (non-integer, ≤0, no matching row) and invalid verdict (anything other than `kept`/`discarded`/`actioned`) exit code 1 with a useful stderr message and no DB write.
7. Unit tests cover schema migration v3, both new `Memory` methods (success + failure + re-rating), and `renderRateList` (empty + plain + color).
8. Integration test exercises the CLI end-to-end: rate a candidate, then `--list` shows the rating.
9. `npm test`, `npm run build`, `npm run lint` all exit 0. Total suite: 115 + 1 skip → ~125 + 1 skip.
10. `CHANGELOG.md` has a `v0.4.0` entry.
11. `docs/ROADMAP.md` moves `glean rate` from Up next #1 to Done. Remaining Up next renumbered 1–3.

## 2. Locked decisions (from brainstorm)

- **Identifier:** integer candidate id only. Self-contained `--list` flag handles discovery. Smart identifiers (slug, title-substring, "latest") explicitly rejected — ambiguity isn't worth the friction.
- **Verbs:** `kept` / `discarded` / `actioned`. Three distinct signals. No numeric scale (overkill), no two-level (loses the highest-signal verb), no freeform notes (YAGNI).
- **Mutability:** ratings ARE mutable. Re-rating overwrites the previous verdict and updates `user_rating_at`. (Distinct from `dossier_existed_at_7d`, which is a fact at a moment in time; ratings are judgments that can evolve.)
- **Discovery surface:** ships with the write path in this release. `glean rate --list` prints recent rateable dossiers (last 20, hardcoded). Replaces the temporary need to `sqlite3` directly. Up next #2 (`glean today` enriched) will later make this even more ergonomic; this release is self-contained.
- **Engine isolation:** `pipeline.ts`, `executor.ts`, discovery modules, and the v0.3.0 sweep are not touched. Ratings accumulate but are not yet read by anything.
- **Module structure:** unlike `today.ts`/`render-today.ts` which split scanner from renderer, `rate.ts` is single-file: the "scanner" is a one-line `Memory` call, so splitting adds files without adding clarity. Renderer is a pure exported function for testability.
- **Version:** `v0.4.0` (minor bump — new schema migration AND new CLI surface).

## 3. Architecture

Three touch points:

```
glean rate --list
  ├─ open Memory
  ├─ memory.listRecentRatableCandidates(20)
  ├─ renderRateList(rows, isTTY)
  └─ stdout.write(...)

glean rate <id> <verdict>
  ├─ validate id (integer, > 0)
  ├─ validate verdict (kept/discarded/actioned)
  ├─ open Memory
  ├─ memory.setUserRating(id, verdict)
  ├─ if updated: stdout.write("rated N (title) as <verdict>")
  └─ else: stderr.write("error: no candidate with id N"); exit 1
```

The split between `memory.ts` (SQL, storage primitives) and `rate.ts` (rendering, pure formatting) mirrors the v0.2.1 pattern. The CLI wiring in `src/cli.ts` is thin glue.

## 4. Schema migration v3

```sql
ALTER TABLE candidates ADD COLUMN user_rating TEXT;
ALTER TABLE candidates ADD COLUMN user_rating_at INTEGER;
```

Then `PRAGMA user_version = 3`.

Semantics:
- `user_rating = NULL` and `user_rating_at = NULL` → unrated (default for all existing rows and new rows that haven't been rated yet).
- `user_rating` is one of `'kept'`, `'discarded'`, `'actioned'`. SQLite has no native enum, so the constraint is enforced at the CLI/`Memory` layer; the DB column accepts any TEXT.
- `user_rating_at` is unix ms of the latest rating write.

Two separate `ALTER TABLE` statements because SQLite's `ALTER TABLE ADD COLUMN` adds only one column at a time. Inside the migration `BEGIN`/`COMMIT` block:

```ts
if (version < 3) {
  this.db.exec('BEGIN');
  try {
    this.db.exec('ALTER TABLE candidates ADD COLUMN user_rating TEXT');
    this.db.exec('ALTER TABLE candidates ADD COLUMN user_rating_at INTEGER');
    this.db.pragma('user_version = 3');
    this.db.exec('COMMIT');
  } catch (e) {
    this.db.exec('ROLLBACK');
    throw e;
  }
}
```

Inserted after the existing `if (version < 2)` block. The `version` variable is still captured once at the top of `migrate()` — a fresh DB at v0 applies all three migrations in order.

## 5. Module details

### 5.1 `Memory.setUserRating`

```ts
setUserRating(candidateId: number, rating: 'kept' | 'discarded' | 'actioned'): { updated: boolean; title: string | null } {
  const row = this.db.prepare('SELECT title FROM candidates WHERE id = ?').get(candidateId) as { title: string } | undefined;
  if (!row) return { updated: false, title: null };
  this.db.prepare('UPDATE candidates SET user_rating = ?, user_rating_at = ? WHERE id = ?')
    .run(rating, Date.now(), candidateId);
  return { updated: true, title: row.title };
}
```

Reads first so the CLI can echo the title back to the user ("rated 42 (Handle TODO in src/cli.ts) as kept"). Two prepares; two roundtrips. Performance is not a concern at one-call-per-rating frequencies.

NOT write-once. Re-rating from `kept` to `discarded` updates both columns. The previous value is overwritten without history. (If history becomes valuable later, add a separate `user_rating_history` table — out of scope here.)

### 5.2 `Memory.listRecentRatableCandidates`

```ts
listRecentRatableCandidates(limit: number): Array<{
  id: number;
  title: string;
  candidate_type: 'research-dossier' | 'fetch-docs';
  ended_at: number;
  dossier_path: string;
  user_rating: 'kept' | 'discarded' | 'actioned' | null;
}> {
  return this.db.prepare(
    `SELECT id, title, candidate_type, ended_at, dossier_path, user_rating
       FROM candidates
      WHERE outcome IS NOT NULL
        AND dossier_path IS NOT NULL
      ORDER BY ended_at DESC
      LIMIT ?`,
  ).all(limit) as Array<{ id: number; title: string; candidate_type: 'research-dossier' | 'fetch-docs'; ended_at: number; dossier_path: string; user_rating: 'kept' | 'discarded' | 'actioned' | null }>;
}
```

"Ratable" = settled (outcome non-null) AND produced a dossier (dossier_path non-null). A failed task or timeout has nothing for the user to rate. Already-rated rows are still returned so the user can see (and update) past verdicts.

### 5.3 `src/lib/rate.ts` — `renderRateList`

Pure formatter, no I/O. Same ANSI-on-TTY pattern as `render-today.ts`.

```ts
import type { /* row type from above */ } from './memory.js';

type Painter = {
  bold:  (s: string) => string;
  dim:   (s: string) => string;
  green: (s: string) => string;
  red:   (s: string) => string;
};

const ANSI: Painter = {
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
};
const PLAIN: Painter = { bold: (s) => s, dim: (s) => s, green: (s) => s, red: (s) => s };

export function renderRateList(rows: Array<{...}>, useColor: boolean): string {
  if (rows.length === 0) {
    return 'No ratable dossiers found.';
  }
  const c = useColor ? ANSI : PLAIN;
  // header + table rows + footer
}
```

Output format (plain mode):

```
Recent rateable dossiers (most recent first):

  id   when              type              rating       title
  42   2026-05-26 13:01  research-dossier  kept         Handle TODO in src/cli.ts
  41   2026-05-26 12:58  fetch-docs        (unrated)    Pre-fetch docs for better-sqlite3
  40   2026-05-25 10:13  research-dossier  discarded    Handle TODO in src/foo.ts

Rate one with: glean rate <id> <kept|discarded|actioned>
```

Rules:
- Header line: `Recent rateable dossiers (most recent first):`. Bold in color mode.
- Blank line.
- Column header row: `id`, `when`, `type`, `rating`, `title`. Dim in color mode.
- Each row: id (right-padded to 4 chars), when (ISO `YYYY-MM-DD HH:MM` from `ended_at` in local tz, fixed width 16), type (left-padded to 17 chars), rating (left-padded to 12 chars), then title.
- Rating column shows the verb (`kept` / `discarded` / `actioned`) or `(unrated)` for NULL. Color: green for `kept`/`actioned`, red for `discarded`, dim for `(unrated)`.
- Blank line.
- Footer hint line: `Rate one with: glean rate <id> <kept|discarded|actioned>`. Dim in color mode.

Empty case: `No ratable dossiers found.` (no trailing newline; CLI adds the `\n`).

### 5.4 `src/cli.ts` — `rateCmd`

Add the new subcommand and register under root's `subCommands` map:

```ts
const rateCmd = defineCommand({
  meta: { name: 'rate', description: 'Rate a dossier (kept/discarded/actioned), or --list recent dossiers' },
  args: {
    list: { type: 'boolean', default: false, description: 'Print recent ratable dossiers' },
    id:   { type: 'positional', required: false, description: 'Candidate id to rate' },
    verdict: { type: 'positional', required: false, description: 'kept | discarded | actioned' },
  },
  async run({ args }) {
    const memory = new Memory(join(gleanRoot(), 'memory.db'));
    try {
      if (args.list) {
        const rows = memory.listRecentRatableCandidates(20);
        const useColor = Boolean(process.stdout.isTTY);
        process.stdout.write(renderRateList(rows, useColor) + '\n');
        return;
      }
      const idStr = args.id as string | undefined;
      const verdict = args.verdict as string | undefined;
      if (!idStr || !verdict) {
        process.stderr.write('usage: glean rate <id> <kept|discarded|actioned>\n       glean rate --list\n');
        process.exit(1);
      }
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) {
        process.stderr.write(`error: invalid id '${idStr}'\n`);
        process.exit(1);
      }
      if (verdict !== 'kept' && verdict !== 'discarded' && verdict !== 'actioned') {
        process.stderr.write(`error: unknown verdict '${verdict}' — use one of: kept, discarded, actioned\n`);
        process.exit(1);
      }
      const result = memory.setUserRating(id, verdict);
      if (!result.updated) {
        process.stderr.write(`error: no candidate with id ${id}\n`);
        process.exit(1);
      }
      process.stdout.write(`rated ${id} (${result.title}) as ${verdict}\n`);
    } finally {
      memory.close();
    }
  },
});
```

Register: append `rate: rateCmd` to the `root` defineCommand's `subCommands` map (existing entries: `run`, `stop`, `version`, `repair`, `today`).

(citty's exact positional-argument syntax may differ slightly from the sketch — the implementer should match the existing `runCmd`/`repairCmd` patterns in `src/cli.ts`. The behavioral contract — validate id, validate verdict, write, echo — is what matters.)

## 6. Module changes

| File | Change |
|---|---|
| `src/lib/memory.ts` | Migration v3 in `migrate()`; `setUserRating` + `listRecentRatableCandidates` methods. ~30 LOC delta. |
| `src/lib/memory.test.ts` | 6 new tests (migration v3 × 2, setUserRating success/failure, re-rating, listRecentRatableCandidates). ~70 LOC delta. |
| `src/lib/rate.ts` | **New.** `renderRateList` + ANSI helpers. ~50 LOC. |
| `src/lib/rate.test.ts` | **New.** 3 tests (empty, plain, color). ~50 LOC. |
| `src/cli.ts` | Add `rateCmd` + register on root. ~50 LOC delta. |
| `test/integration/v16-rate.test.ts` | **New.** 2 tests (rate-and-list round-trip, invalid-verdict exits 1). ~70 LOC. |
| `package.json` | Bump version to `0.4.0`. |
| `CHANGELOG.md` | v0.4.0 entry. |
| `docs/ROADMAP.md` | Move `glean rate` from Up next #1 to Done. Renumber remaining Up next (2→1, 3→2, 4→3). |

Estimated implementation LOC: ~100. Tests: ~150–180.

## 7. Testing plan

### 7.1 `memory.test.ts` additions

1. **Migration v3 on fresh DB.** Both `user_rating` and `user_rating_at` columns exist after open via `PRAGMA table_info('candidates')`. `user_version = 3`. Both columns default to NULL.
2. **Migration v3 idempotency.** Opening a v3 DB does not re-apply. Opening a v2 DB applies only v3.
3. **`setUserRating` happy path.** Seed a candidate. Call `setUserRating(id, 'kept')`. Assert `{updated: true, title: <expected>}`. Assert the row now has `user_rating = 'kept'` and `user_rating_at` is a recent unix ms.
4. **`setUserRating` on missing id.** Call `setUserRating(999, 'kept')` against an empty DB. Assert `{updated: false, title: null}`. Assert no rows affected.
5. **Re-rating overwrites.** Rate `kept`. Re-rate the same id `discarded`. Assert final `user_rating = 'discarded'`. Assert `user_rating_at` is updated (later than the first write).
6. **`listRecentRatableCandidates` filtering and ordering.** Seed 4 candidates: one with no outcome, one with no dossier_path, one fully eligible (older), one fully eligible (newer). Assert only the two eligible rows are returned, newest first.

### 7.2 `rate.test.ts` (new)

1. **Empty list renders empty-case message.** `renderRateList([], false)` → `'No ratable dossiers found.'`. No ANSI escapes.
2. **Plain render (no ANSI).** Three rows including one rated `kept`, one rated `discarded`, one unrated. Assert no `\x1b[` codes. Assert header text, column headers, all three ids, all three titles, `kept`, `discarded`, `(unrated)`, and the footer hint all appear.
3. **Color render emits ANSI.** Same input with `useColor: true`. Assert `\x1b[1m` (bold header), `\x1b[32m` (green for `kept`/`actioned`), `\x1b[31m` (red for `discarded`), `\x1b[2m` (dim for `(unrated)` and footer/column-header). Add `/* eslint-disable no-control-regex */` at the top of the file (same pattern as `render-today.test.ts`).

### 7.3 Integration `v16-rate.test.ts`

1. **Round-trip.** Pre-populate a memory.db with one settled candidate (use the same fixture pattern as `v13-memory.test.ts`). Spawn `node bin/glean.js rate <id> kept`. Assert exit 0, stdout contains `rated <id>` and `as kept`. Then spawn `node bin/glean.js rate --list`. Assert exit 0, stdout contains the candidate id and the word `kept`.
2. **Invalid verdict.** Spawn `node bin/glean.js rate <id> wat`. Assert exit 1, stderr contains `unknown verdict 'wat'`.

### 7.4 Regression discipline

All 115 existing tests must continue to pass. Total target: ~125 passing + 1 skipped.

## 8. Out of scope (explicit)

- **No alternative identifiers** (slug, fingerprint, title-substring, "latest").
- **No batch rating** (`glean rate 1-5 discarded`).
- **No rating notes / freeform comments.**
- **No `glean unrate` or `--clear`.** Re-rate to a different verb instead; clearing to NULL is not exposed.
- **No interactive TUI** (`glean rate` with no args opens a walkthrough).
- **No surfacing in `glean today`.** That's explicitly Up next #2.
- **No ranker behavior change.** Ratings accumulate; nothing reads them.
- **No `--limit N` on `--list`.** Hardcoded 20.
- **No history retention.** Re-rating overwrites; the previous value is lost.

## 9. Rollback / failure modes

- **`memory.db` unavailable** — `Memory` constructor throws; CLI exits 1 with the underlying error. (Unlike `glean run` which protects engine functions from memory failure, `glean rate` IS a memory-only command — failure to open memory IS command failure.)
- **Migration v3 fails mid-apply** — `BEGIN`/`ROLLBACK` keeps `user_version` at 2. Next invocation retries.
- **Invalid id (non-integer, ≤0)** — validated at CLI layer before any DB call. Exit 1, no write.
- **Valid id with no matching row** — `setUserRating` returns `{updated: false}`. CLI prints `error: no candidate with id N`, exits 1.
- **Invalid verdict** — validated at CLI layer. Exit 1, no write.
- **User wants to wipe ratings only** — `sqlite3 %USERPROFILE%\glean\memory.db "UPDATE candidates SET user_rating = NULL, user_rating_at = NULL"`. Document in CHANGELOG.

## 10. Open questions deferred

- Whether to surface ratings in `glean today` (yes, but that's Up next #2 — design out of scope here).
- Whether to expose `--clear` / unrate. Wait for an actual need.
- Whether to add `--limit N` on `--list`. Hardcoded 20 is fine until it isn't.
- Whether to add a `user_rating_history` table for evolving judgments. Wait for the ranker to need it.
- Whether to add a `glean rate <id>` with no verdict that prints the current rating for inspection. Probably YAGNI; `--list` already shows it.
