# Glean v0.1.2 Dep-Parser Patch — Design Spec

**Status:** approved design, not yet implemented
**Date:** 2026-05-25
**Author:** Jonny-boy9000 (via brainstorming session)
**Scope:** Single-issue quality patch. Fix the section-scoping bug in `discover-deps` that produced 32 false-positive candidates (`"name"`, `"description"`, `"scripts"`, `"bin"`, etc.) in the v0.1.1 dogfood. Ships as non-breaking `v0.1.2`. Does NOT include the strategic shifts proposed in the third-party critique (persistent memory, inbox surface, event triggers, capacity blending) — those each get their own brainstorm if/when prioritized.

---

## 1. Goal and success criteria

In the v0.1.1 dogfood, `discover-deps` emitted 32 spurious `fetch-docs` candidates because `parseAddedPackages` for `package.json` matched every JSON key in the diff (including top-level metadata like `name`, `description`, `scripts`, `bin`), not just keys under `dependencies`/`devDependencies`. The same latent bug exists in the `Cargo.toml` and `pyproject.toml` parsers (which match `<name> =` for every TOML line). Task 16 of v0.1.1 fixed `--diff-filter=AM`, which inadvertently exposed the bug more often because newly-added manifests now show every field as a `+` line.

v0.1.2 rewrites `discover-deps` to use full-file parsing at git boundaries instead of diff-line parsing. The new flow correctly scopes to dependency sections for all 5 manifest types.

**Done when:**

1. 81 tests pass, 1 skipped (added 3 new section-scoping tests for package.json, Cargo.toml, pyproject.toml).
2. Manual dogfood validation: `glean run --project C:\Glean --dry-run` produces zero `dep` candidates with packages like `name`, `description`, `scripts`, `bin` (was 32 spurious in v0.1.1).
3. `npm test`, `npm run build`, `npm run lint` all exit 0.
4. `CHANGELOG.md` has a v0.1.2 entry.
5. `docs/open-work/04-v011-dogfood.md` AC3 row corrected from `yes` → `PARTIAL`.
6. New dep `smol-toml` adds <50KB to `node_modules`.

## 2. Locked decisions (from brainstorm)

- **Scope:** pure quality patch (option A). Just the dep-parser fix + dogfood findings. No strategic shifts.
- **Parser scope:** all 5 manifest types via section-aware parsing (option A). Not just `package.json`.
- **Implementation strategy:** full-file parse — load pre/post manifest content via `git show`, parse with proper parsers (JSON.parse for json, `smol-toml` for TOML, regex for go.mod/requirements.txt), compute set difference. NOT section-aware diff parsing.
- **Patch shape:** two thematic commits on a single `v0.1.2` branch off `main@d88cebb`. Commit 1 is the parser rewrite + tests + new dep. Commit 2 is version bump + CHANGELOG + AC3 wording fix.
- **Versioning:** non-breaking patch. Same config schema, same CLI surface.
- **Third-party critique outcome:** the persistent-memory point is the only strategically-important one, and it's tabled for a separate brainstorm. The inbox/event-trigger/capacity-blending/web-mobile-pivot ideas are explicitly deferred until product-market-fit evidence in the current shape exists.

## 3. Architecture

Replace diff-based parsing with full-file parsing at git boundaries.

For each present manifest type:

1. Run `git log --since=14.days --format=%H -- <manifest>` to list commits in the window.
2. If zero commits → skip (no recent activity for this manifest).
3. Get file contents at two points:
   - **Pre-window:** `git show <commit-just-before-oldest-window-commit>:<manifest>`. If that commit doesn't exist (the file was newly-added in the window) or the path doesn't exist at that commit → treat as empty string.
   - **Current:** `readFileSync(<projectPath>/<manifest>, 'utf8')`.
4. Parse both with `parseManifestDeps(type, content)` into a `Set<string>` of dependency names.
5. Emit one `fetch-docs` candidate per name in `currentDeps \ preDeps`.

## 4. Module changes

| File | Change |
|---|---|
| `src/lib/discover-deps.ts` | Rewrite `discoverDeps`. Remove `parseAddedPackages` and `extractPackageName`. Add `parseManifestDeps(manifest, content): Set<string>` plus two small git-surface helpers (`recentCommits`, `gitShowAtParent`). |
| `src/lib/discover-deps.test.ts` | Existing 2 tests preserved (assertions unchanged — same fixtures, same outcomes under new flow). Add 3 new tests for section-scoping (package.json top-level fields, Cargo.toml [package] table, pyproject.toml [build-system]/[project]/[tool.*]). |
| `package.json` | Add `smol-toml` dependency. Bump version to `0.1.2`. |
| `CHANGELOG.md` | Add v0.1.2 entry. |
| `docs/open-work/04-v011-dogfood.md` | AC3 row: `yes` → `PARTIAL` (keep the existing explanatory note). |
| `docs/open-work/05-v012-dogfood.md` (new) | Light validation report. |

## 5. Detailed module behavior

### 5.1 `parseManifestDeps`

```ts
type Manifest = 'package.json' | 'requirements.txt' | 'go.mod' | 'Cargo.toml' | 'pyproject.toml';

export function parseManifestDeps(manifest: Manifest, content: string): Set<string> {
  // Returns the set of dependency package names declared in the file.
  // Top-level metadata fields (name, version, description, scripts, etc.) are excluded.
  // Returns empty set on parse errors (treat as "no deps").
}
```

Per-format scoping:

- **`package.json`** — `JSON.parse(content)`, take keys from `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`. Skip everything else (`name`, `version`, `description`, `scripts`, `bin`, `files`, `engines`, etc.).
- **`requirements.txt`** — split lines, skip blank/comment lines, take first token of each non-comment line (everything up to first `=`, `<`, `>`, `;`, `[`, or whitespace). No section concept; the entire file is dependencies.
- **`go.mod`** — track whether we're inside a `require ( ... )` block (multi-line). Also handle single-line `require <module> <version>`. Emit `<module>` only. Ignore `module`, `go`, `toolchain`, `replace`, `exclude` directives.
- **`Cargo.toml`** — `smolToml.parse(content)`, take keys from `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, and `[target.<triple>.dependencies]` (iterate `target` if present). Skip `[package]`, `[features]`, `[lib]`, `[bin]`, `[workspace]`, etc.
- **`pyproject.toml`** — `smolToml.parse(content)`, take from:
  - **PEP 621:** `project.dependencies` (array of requirement strings — extract package name by stripping at first `[`, `<`, `>`, `=`, `;`, `~`, `!`, or whitespace). Plus `project.optional-dependencies.*` (each sub-key is a group; values are arrays of requirement strings — same extraction).
  - **Poetry:** `tool.poetry.dependencies` keys and `tool.poetry.dev-dependencies` keys. (For Poetry the keys ARE the package names.)
  - Skip `[build-system]`, top-level `[project]` non-dependency fields (`name`, `version`, `description`, `authors`, etc.), and any `[tool.<x>]` other than `tool.poetry.*dependencies`.

### 5.2 `discoverDeps` rewrite

```ts
export async function discoverDeps(projectPath: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const m of MANIFESTS) {
    if (!existsSync(join(projectPath, m))) continue;

    const commits = recentCommits(projectPath, m, 14);
    if (commits.length === 0) continue;

    const oldestInWindow = commits[commits.length - 1];
    const preContent = gitShowAtParent(projectPath, oldestInWindow, m);
    const currentContent = readFileSync(join(projectPath, m), 'utf8');

    const preDeps = parseManifestDeps(m, preContent);
    const currentDeps = parseManifestDeps(m, currentContent);

    for (const pkg of currentDeps) {
      if (preDeps.has(pkg)) continue;
      const ev: EvidenceDep = { kind: 'dep', manifest: m, package: pkg, added_at: new Date().toISOString() };
      const cand: Candidate = {
        id: uuid(),
        evidence_hash: '',
        type: 'fetch-docs',
        project_path: projectPath,
        evidence: ev,
        est_value: 0,
        est_tokens: 2000,
        status: 'pending',
      };
      cand.evidence_hash = evidenceHash(cand);
      out.push(cand);
    }
  }
  return out;
}
```

### 5.3 Git surface helpers

```ts
function recentCommits(projectPath: string, manifest: string, days: number): string[] {
  try {
    const stdout = execFileSync(
      'git',
      ['-C', projectPath, 'log', `--since=${days}.days`, '--format=%H', '--', manifest],
      { encoding: 'utf8' },
    );
    return stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function gitShowAtParent(projectPath: string, commit: string, manifest: string): string {
  // Returns the file content at the parent of `commit`, or '' if the parent or path doesn't exist.
  try {
    return execFileSync(
      'git',
      ['-C', projectPath, 'show', `${commit}^:${manifest}`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
  } catch {
    return ''; // commit has no parent (initial commit) OR path didn't exist at parent
  }
}
```

## 6. Testing

### 6.1 Existing tests adapted

The 2 existing `discover-deps.test.ts` tests have unchanged assertions and continue to pass under the new flow:

1. "emits one candidate per recently-added package.json entry" — fixture: lodash committed first, zod added later. `preDeps = {lodash}`, `currentDeps = {lodash, zod}`, set-difference = `{zod}`. Same outcome as the old diff-based logic.
2. "emits candidates from a manifest that was ADDED in the last 14 days (not modified)" — fixture: package.json first appears in the second commit. `gitShowAtParent` returns `''`, `preDeps = {}`, all current deps are new.

### 6.2 New tests

Three new tests, one per format with the latent bug:

**`package.json: ignores top-level fields like name/description/scripts`** — fixture with `name`, `version`, `description`, `scripts`, `bin`, `dependencies.lodash`, `devDependencies.typescript`. Asserts `lodash` and `typescript` emitted; `name`/`version`/`description`/`scripts`/`bin`/`build`/`test`/`mycli` NOT emitted.

**`Cargo.toml: ignores [package] table, captures [dependencies] and [dev-dependencies]`** — fixture with `[package] name = "my-crate"`, `version`, `edition`, `[dependencies] serde`, `tokio`, `[dev-dependencies] mockito`. Asserts `serde`/`tokio`/`mockito` emitted; `name`/`version`/`edition` NOT emitted.

**`pyproject.toml: ignores [build-system] and top-level project fields, captures dependencies`** — fixture with `[build-system]`, `[project]` (name/version/description/dependencies array), `[project.optional-dependencies]`, `[tool.ruff]`. Asserts `requests`/`click`/`pytest`/`black` emitted; `name`/`version`/`description`/`setuptools`/`line-length`/`build-backend`/`requires` NOT emitted.

The pyproject test is the most strenuous — it exercises PEP 621 array-of-strings dep extraction, optional-dependencies sub-groups, AND `[tool.*]` exclusion in one fixture.

### 6.3 Suite total

| Module | Before | After |
|---|---|---|
| discover-deps | 2 | 5 |
| (all others) | 76 | 76 |
| **Total** | **78 + 1 skip** | **81 + 1 skip** |

### 6.4 Manual validation

After implementation, dry-run dogfood against `C:\Glean`:

```bash
glean run --project C:\Glean --dry-run
```

Inspect the resulting `candidates.json`. Expectation: zero `evidence.kind === "dep"` candidates with `evidence.package` in `{name, description, scripts, bin, glean, version, ...}`. Only real dependency names from the actual `package.json`'s `dependencies` and `devDependencies` sections.

Document the result in `docs/open-work/05-v012-dogfood.md` (light report — just confirms the regression doesn't recur and notes the count of correctly-emitted dep candidates).

## 7. Rollout

### 7.1 Branch + commits

Single `v0.1.2` branch off `main@d88cebb`. Two commits:

| # | Commit | Files | Risk |
|---|---|---|---|
| 1 | `fix(discover-deps): scope to dependency sections via full-file parse` | `package.json` (+smol-toml), `src/lib/discover-deps.ts`, `src/lib/discover-deps.test.ts` | Med — rewrites the parser. Full-file approach reduces edge-case risk. |
| 2 | `chore: bump version to 0.1.2, add CHANGELOG; fix v0.1.1 dogfood AC3 wording` | `package.json`, `CHANGELOG.md`, `docs/open-work/04-v011-dogfood.md`, `docs/open-work/05-v012-dogfood.md` | Low — admin. |

After both commits, merge to `main` with `--no-ff -m "Merge v0.1.2 dep-parser patch into main"`, tag `v0.1.2`, push branch + tag.

### 7.2 Acceptance criteria

1. 81 tests pass, 1 skipped.
2. Manual dogfood shows zero `dep` candidates with spurious package names.
3. `npm test`, `npm run build`, `npm run lint` exit 0.
4. `CHANGELOG.md` has v0.1.2 entry.
5. `04-v011-dogfood.md` AC3 row corrected.
6. `node_modules/smol-toml` <50KB.

### 7.3 Explicit non-goals

- No new `config.json` schema fields. Section scoping is hardcoded.
- No memory substrate (third-party critique's strongest point — tabled for separate brainstorm).
- No inbox UI, event triggers, capacity blending, multi-source funding (third-party critique's broader vision — deferred).
- No POSIX work, no `draft-impl`, no scheduling, no `glean discard/gc/peek`.
- No discover-deps performance optimization (the new flow runs 2 `git show`s per manifest — acceptable for current scale).
- No automatic cleanup of spurious `docs/name.md`/`docs/description.md`/etc. files in the user's existing dogfood output (user-side cleanup).

### 7.4 Rollback plan

If the new parser regresses against real-world manifests:
- `git revert` the parser commit. Version stays at `0.1.2` from commit 2; cut `0.1.3` with a follow-up.
- If the issue is just one format, patch the specific `parseManifestDeps` branch rather than reverting the whole rewrite.

### 7.5 Risks

| Risk | Mitigation |
|---|---|
| `smol-toml` doesn't handle a real-world TOML quirk | Tests cover both PEP 621 and basic Cargo cases. If a user reports failure, add a targeted test + fix in v0.1.3. |
| `git show <commit>^:<path>` fails for the initial commit (no parent) | `gitShowAtParent` returns `''` via try/catch → all current deps treated as new. |
| Full-file parse misses deps that were added then removed within the same window | By design. We surface "currently-new vs window-start", not "ever-existed in window". |
| Cross-platform line-ending differences in TOML fixtures | Node `writeFileSync` writes `\n` regardless of OS; smol-toml accepts both. Low risk. |
| Adding a runtime dep changes install footprint | smol-toml is ~10KB minified, zero transitive deps. Acceptance criterion 6 verifies. |

## 8. Out of scope (saved for later brainstorms)

- **Persistent memory substrate** — the most strategically defensible point from the third-party critique. Worth its own brainstorm soon, before the engine accumulates too much stateless cruft.
- **Inbox UI / event triggers / capacity blending / web+mobile** — the third-party critique's bigger vision. Deferred until product-market-fit evidence in the current dev-tool shape exists.
- POSIX port (issue #1).
- `draft-impl` worktree drafting.
- Scheduling (Task Scheduler / cron / launchd).
- `glean discard` / `gc` / `peek` subcommands.
- SessionStart hook.
- Resume-after-crash.
- Multi-project per run.
- Parallelism.
- npm publish, demo screenshot, terminal GIF.

Each gets its own brainstorm → spec → plan cycle when prioritized.

---

*Brainstorm session: 2026-05-25. Third-party strategic critique reviewed and addressed: persistent memory deferred for separate brainstorm; broader product pivot deferred until evidence demands it.*
