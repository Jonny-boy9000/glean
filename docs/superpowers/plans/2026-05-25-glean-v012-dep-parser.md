# Glean v0.1.2 Dep-Parser Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the section-scoping bug in `discover-deps` that produced 32 false-positive candidates in the v0.1.1 dogfood. Rewrite the parser to use full-file parsing at git boundaries (load pre/post content via `git show`, parse with proper parsers, compute set difference) so dependency-section scoping is correct for all 5 supported manifest types.

**Architecture:** Non-breaking patch on `main@c866d5e`. Two thematic commits on a `v0.1.2` branch: (1) parser rewrite + smol-toml dep + tests; (2) version bump + CHANGELOG + dogfood doc + AC3 wording fix. Then merge with `--no-ff`, tag `v0.1.2`, push.

**Tech Stack:** Node 20, TypeScript, vitest (existing). One new runtime dep: `smol-toml` (~10KB, zero transitive deps).

**Spec:** `docs/superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md`. Read it first; this plan implements it.

---

## File Structure

```
C:\Glean\
  src\lib\
    discover-deps.ts        REWRITE  — parseManifestDeps + git helpers + new discoverDeps
    discover-deps.test.ts   MODIFY   — keep 2 existing tests, add 3 section-scoping tests
  package.json              MODIFY   — add smol-toml dep, bump version to 0.1.2
  CHANGELOG.md              MODIFY   — add v0.1.2 entry
  docs\open-work\
    04-v011-dogfood.md      MODIFY   — AC3 row: "yes" → "PARTIAL"
    05-v012-dogfood.md      NEW      — light validation report
```

No new file modules; everything stays in `discover-deps.ts`. Existing test fixture patterns (mkdtempSync + git init) carry over.

---

## Task ordering

Branch first (Task 1). Then the parser rewrite + tests + new dep in a single TDD-discipline task (Task 2 → commit 1). Manual dogfood validation against `C:\Glean` (Task 3). Then version + CHANGELOG + AC3 fix + dogfood doc (Task 4 → commit 2). Then merge + tag + push (Task 5).

---

## Task 1: Create the v0.1.2 branch

**Files:** none (branch only)

- [ ] **Step 1: Confirm clean state**

Run:
```bash
cd /c/Glean && git status && git log --oneline -3
```
Expected: clean working tree, HEAD at `c866d5e` ("spec: glean v0.1.2 dep-parser patch design"), on `main`.

- [ ] **Step 2: Create and switch to branch**

```bash
cd /c/Glean && git checkout -b v0.1.2 && git branch --show-current
```
Expected: `v0.1.2`.

---

## Task 2: Parser rewrite + new tests (commit 1)

**Files:**
- Modify: `C:\Glean\package.json`
- Modify: `C:\Glean\src\lib\discover-deps.ts` (full rewrite)
- Modify: `C:\Glean\src\lib\discover-deps.test.ts` (add 3 new tests; preserve 2 existing)

### Step 1: Install smol-toml

```bash
cd /c/Glean && npm install smol-toml
```
Expected: smol-toml added to `package.json` dependencies. Verify with `cat package.json | grep smol-toml`.

Check install footprint (acceptance criterion 6):
```bash
du -sh node_modules/smol-toml
```
Expected: <50KB.

### Step 2: Write 3 new failing tests in `src/lib/discover-deps.test.ts`

The file already has 2 tests inside `describe('discoverDeps', ...)`. Append these 3 tests INSIDE that same describe block, after the existing tests:

```ts
it('package.json: ignores top-level fields like name/description/scripts', async () => {
  const r = mkdtempSync(join(tmpdir(), 'glean-deps-scope-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t && git config user.name t', { cwd: r });
  writeFileSync(join(r, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: r });
  writeFileSync(join(r, 'package.json'), JSON.stringify({
    name: 'my-app',
    version: '1.0.0',
    description: 'A demo app',
    scripts: { build: 'tsc', test: 'vitest' },
    bin: { mycli: './bin/cli.js' },
    dependencies: { lodash: '^4.0.0' },
    devDependencies: { typescript: '^5.0.0' },
  }, null, 2));
  execSync('git add . && git commit -q -m "add manifest"', { cwd: r });

  const cands = await discoverDeps(r);
  const packages = cands.map((c) => (c.evidence as { package: string }).package);
  expect(packages).toContain('lodash');
  expect(packages).toContain('typescript');
  expect(packages).not.toContain('name');
  expect(packages).not.toContain('version');
  expect(packages).not.toContain('description');
  expect(packages).not.toContain('scripts');
  expect(packages).not.toContain('bin');
  expect(packages).not.toContain('build');
  expect(packages).not.toContain('test');
  expect(packages).not.toContain('mycli');
});

it('Cargo.toml: ignores [package] table, captures [dependencies] and [dev-dependencies]', async () => {
  const r = mkdtempSync(join(tmpdir(), 'glean-deps-cargo-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t && git config user.name t', { cwd: r });
  writeFileSync(join(r, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: r });
  writeFileSync(join(r, 'Cargo.toml'), `[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
mockito = "1.0"
`);
  execSync('git add . && git commit -q -m "add Cargo.toml"', { cwd: r });

  const cands = await discoverDeps(r);
  const packages = cands.map((c) => (c.evidence as { package: string }).package);
  expect(packages).toContain('serde');
  expect(packages).toContain('tokio');
  expect(packages).toContain('mockito');
  expect(packages).not.toContain('name');
  expect(packages).not.toContain('version');
  expect(packages).not.toContain('edition');
});

it('pyproject.toml: ignores [build-system] and top-level project fields, captures dependencies', async () => {
  const r = mkdtempSync(join(tmpdir(), 'glean-deps-py-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t && git config user.name t', { cwd: r });
  writeFileSync(join(r, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: r });
  writeFileSync(join(r, 'pyproject.toml'), `[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "my-pkg"
version = "0.1.0"
description = "demo"
dependencies = [
  "requests>=2.28",
  "click>=8.0",
]

[project.optional-dependencies]
dev = ["pytest>=7", "black"]

[tool.ruff]
line-length = 100
`);
  execSync('git add . && git commit -q -m "add pyproject"', { cwd: r });

  const cands = await discoverDeps(r);
  const packages = cands.map((c) => (c.evidence as { package: string }).package);
  expect(packages).toContain('requests');
  expect(packages).toContain('click');
  expect(packages).toContain('pytest');
  expect(packages).toContain('black');
  expect(packages).not.toContain('name');
  expect(packages).not.toContain('version');
  expect(packages).not.toContain('description');
  expect(packages).not.toContain('setuptools');
  expect(packages).not.toContain('line-length');
  expect(packages).not.toContain('build-backend');
  expect(packages).not.toContain('requires');
});
```

### Step 3: Run, verify the 3 new tests FAIL

```bash
cd /c/Glean && npx vitest run src/lib/discover-deps.test.ts 2>&1 | tail -25
```
Expected: 2 existing tests pass, 3 new tests fail. The current parser emits `name`/`version`/`description` etc. for package.json (and similar for Cargo/pyproject).

### Step 4: Rewrite `src/lib/discover-deps.ts`

Replace the entire file contents with this. The existing `parseAddedPackages` and `extractPackageName` helpers are deleted; everything goes through `parseManifestDeps`.

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { parse as parseToml } from 'smol-toml';
import type { Candidate, EvidenceDep } from './types.js';
import { evidenceHash } from './dedup.js';

type Manifest = EvidenceDep['manifest'];

const MANIFESTS: Manifest[] = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pyproject.toml'];

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
  try {
    return execFileSync(
      'git',
      ['-C', projectPath, 'show', `${commit}^:${manifest}`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
  } catch {
    return '';
  }
}

export function parseManifestDeps(manifest: Manifest, content: string): Set<string> {
  if (!content) return new Set();
  try {
    switch (manifest) {
      case 'package.json':
        return parsePackageJson(content);
      case 'requirements.txt':
        return parseRequirementsTxt(content);
      case 'go.mod':
        return parseGoMod(content);
      case 'Cargo.toml':
        return parseCargoToml(content);
      case 'pyproject.toml':
        return parsePyproject(content);
    }
  } catch {
    return new Set();
  }
}

function parsePackageJson(content: string): Set<string> {
  const pkg = JSON.parse(content) as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const section = pkg[key];
    if (section && typeof section === 'object') {
      for (const name of Object.keys(section as Record<string, unknown>)) out.add(name);
    }
  }
  return out;
}

function parseRequirementsTxt(content: string): Set<string> {
  const out = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // Strip everything from first version-spec / extras / marker / whitespace
    const m = line.match(/^([A-Za-z0-9._-]+)/);
    if (m) out.add(m[1]);
  }
  return out;
}

function parseGoMod(content: string): Set<string> {
  const out = new Set<string>();
  let inRequireBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('require (')) { inRequireBlock = true; continue; }
    if (inRequireBlock && line === ')') { inRequireBlock = false; continue; }
    if (inRequireBlock) {
      // Lines like: github.com/foo/bar v1.2.3
      const m = line.match(/^(\S+)\s+v[\d.]/);
      if (m) out.add(m[1]);
      continue;
    }
    // Single-line require: require github.com/foo/bar v1.2.3
    const single = line.match(/^require\s+(\S+)\s+v[\d.]/);
    if (single) out.add(single[1]);
  }
  return out;
}

function parseCargoToml(content: string): Set<string> {
  const t = parseToml(content) as Record<string, unknown>;
  const out = new Set<string>();
  const sections = ['dependencies', 'dev-dependencies', 'build-dependencies'];
  for (const s of sections) {
    const tbl = t[s];
    if (tbl && typeof tbl === 'object') {
      for (const name of Object.keys(tbl as Record<string, unknown>)) out.add(name);
    }
  }
  // [target.<triple>.dependencies]
  const target = t.target;
  if (target && typeof target === 'object') {
    for (const triple of Object.values(target as Record<string, unknown>)) {
      if (triple && typeof triple === 'object') {
        for (const s of sections) {
          const tbl = (triple as Record<string, unknown>)[s];
          if (tbl && typeof tbl === 'object') {
            for (const name of Object.keys(tbl as Record<string, unknown>)) out.add(name);
          }
        }
      }
    }
  }
  return out;
}

function parsePyproject(content: string): Set<string> {
  const t = parseToml(content) as Record<string, unknown>;
  const out = new Set<string>();

  // PEP 621: [project].dependencies (array of requirement strings)
  const project = t.project as Record<string, unknown> | undefined;
  if (project) {
    const deps = project.dependencies;
    if (Array.isArray(deps)) {
      for (const req of deps) {
        if (typeof req === 'string') {
          const name = extractRequirementName(req);
          if (name) out.add(name);
        }
      }
    }
    const optDeps = project['optional-dependencies'];
    if (optDeps && typeof optDeps === 'object') {
      for (const group of Object.values(optDeps as Record<string, unknown>)) {
        if (Array.isArray(group)) {
          for (const req of group) {
            if (typeof req === 'string') {
              const name = extractRequirementName(req);
              if (name) out.add(name);
            }
          }
        }
      }
    }
  }

  // Poetry: [tool.poetry.dependencies] and [tool.poetry.dev-dependencies]
  const tool = t.tool as Record<string, unknown> | undefined;
  const poetry = tool?.poetry as Record<string, unknown> | undefined;
  if (poetry) {
    for (const s of ['dependencies', 'dev-dependencies']) {
      const tbl = poetry[s];
      if (tbl && typeof tbl === 'object') {
        for (const name of Object.keys(tbl as Record<string, unknown>)) {
          if (name !== 'python') out.add(name); // Poetry uses 'python' to declare the runtime, not a dep
        }
      }
    }
  }

  return out;
}

function extractRequirementName(req: string): string | null {
  // Extracts package name from a PEP 508 requirement string like "requests>=2.28" or "click[extras]>=8".
  const m = req.match(/^([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}
```

### Step 5: Run all tests, verify PASS

```bash
cd /c/Glean && npx vitest run src/lib/discover-deps.test.ts 2>&1 | tail -15
```
Expected: 5 tests pass (2 existing + 3 new).

### Step 6: Run full suite to confirm no regressions

```bash
cd /c/Glean && npm test 2>&1 | tail -10
```
Expected: 81 passed, 1 skipped.

### Step 7: Build + lint clean

```bash
cd /c/Glean && npm run build 2>&1 | tail -5
cd /c/Glean && npm run lint 2>&1 | tail -5
```
Expected: both exit 0.

### Step 8: Commit

```bash
cd /c/Glean && git add package.json package-lock.json src/lib/discover-deps.ts src/lib/discover-deps.test.ts && git commit -m "fix(discover-deps): scope to dependency sections via full-file parse"
```

---

## Task 3: Manual dogfood validation

**Files:** none (validation only — feeds Task 4's dogfood doc)

The parser rewrite is now on the v0.1.2 branch. Build, install globally, run dry-run against `C:\Glean`, inspect the candidates.

- [ ] **Step 1: Build + reinstall globally**

```bash
cd /c/Glean && npm run build && npm install -g .
glean version
```
Expected: `0.1.1` (we haven't bumped the version yet — that's Task 4). Note the version output; you'll bump it next.

- [ ] **Step 2: Dry-run dogfood**

```bash
glean run --project C:\Glean --dry-run
```

The dry-run discovers candidates and writes `%USERPROFILE%\glean\state\<run-id>\candidates.json` without spawning Claude.

- [ ] **Step 3: Inspect dep candidates**

Find the latest candidates.json:

PowerShell:
```powershell
$latest = Get-ChildItem "$env:USERPROFILE\glean\state" -Directory | Where-Object Name -ne 'RUN.lock' | Sort-Object LastWriteTime | Select-Object -Last 1
$cands = Get-Content "$($latest.FullName)\candidates.json" | ConvertFrom-Json
$cands.ranked | Where-Object { $_.evidence.kind -eq 'dep' } | ForEach-Object { $_.evidence.package }
```

Expected:
- Zero packages named `name`, `description`, `scripts`, `bin`, `version`, `glean`, `build`, `test`, `mycli`, etc.
- Only real dependency names from `package.json`'s `dependencies` and `devDependencies` (e.g. `citty`, `fast-glob`, `uuid`, `yaml`, `zod`, `smol-toml`, `typescript`, `vitest`, etc.).

- [ ] **Step 4: Count dep candidates**

```powershell
($cands.ranked | Where-Object { $_.evidence.kind -eq 'dep' }).Count
```

Note this number — Task 4's dogfood doc records it. In v0.1.1 dogfood it was 32 (mostly spurious). With the fix it should be approximately the actual count of recently-added deps in this repo (likely 0-5 depending on what's recently been added; smol-toml itself was just added in Task 2 so should show up).

- [ ] **Step 5: Note any surprises**

If any spurious package names still appear, OR if any expected dep is missing, document them — that's a finding for the dogfood doc. Do NOT proceed to Task 4 if the parser is still producing obvious garbage; fix forward instead.

---

## Task 4: Version bump + CHANGELOG + AC3 fix + dogfood doc (commit 2)

**Files:**
- Modify: `C:\Glean\package.json`
- Modify: `C:\Glean\CHANGELOG.md`
- Modify: `C:\Glean\docs\open-work\04-v011-dogfood.md`
- Create: `C:\Glean\docs\open-work\05-v012-dogfood.md`

### Step 1: Bump version

In `package.json`, change `"version": "0.1.1"` to `"version": "0.1.2"`.

### Step 2: Add v0.1.2 entry to CHANGELOG.md

Open `CHANGELOG.md` and insert this BLOCK directly under the top `# Changelog` heading and ABOVE the existing `## v0.1.1` section:

```markdown
## v0.1.2 — 2026-05-25

Single-issue quality patch from the v0.1.1 dogfood findings.

### Fixed
- `discover-deps` no longer emits spurious `fetch-docs` candidates for top-level manifest fields like `name`, `version`, `description`, `scripts`, `bin`. The parser is rewritten to use full-file parsing at git boundaries: it loads the manifest at the pre-window and current commits, parses both with proper parsers (JSON.parse for `package.json`, `smol-toml` for `Cargo.toml`/`pyproject.toml`, regex for `go.mod`/`requirements.txt`), and emits candidates for packages present in current dependency sections that weren't there at window-start. Fixes 32 of 35 spurious candidates from the v0.1.1 dogfood.

### Added
- `smol-toml` runtime dependency (~10KB) for `Cargo.toml` and `pyproject.toml` parsing.

### Tests
- Suite: 78 + 1 skip → 81 + 1 skip.
- 3 new tests verify section scoping for `package.json`, `Cargo.toml`, `pyproject.toml`.

```

### Step 3: Fix AC3 wording in v0.1.1 dogfood doc

Open `docs/open-work/04-v011-dogfood.md`. Find the acceptance-criteria table row for criterion #3 (`glean repair recovered the 11 historical OUT.md`). The current Result column reads `yes`. Change it to `PARTIAL`. Leave the explanatory note below the table unchanged — it correctly documents why the 11 files were unrecoverable.

The find/replace operation: locate the line containing the AC3 row in the table and change the `yes` value to `PARTIAL`. The exact line depends on how the implementer formatted it earlier; the row is identifiable by its second column matching the AC3 criterion description.

### Step 4: Write the v0.1.2 dogfood doc

Create `C:\Glean\docs\open-work\05-v012-dogfood.md` using actual values from Task 3:

```markdown
# v0.1.2 Dogfood Validation — 2026-05-25

Light validation report confirming the v0.1.1 dep-parser regression doesn't recur.

## Command run

```
glean run --project C:\Glean --dry-run
```

## Dep candidates emitted (after parser rewrite)

- **Count:** <fill in from Task 3 Step 4>
- **Package names:** <list them — they should all be real entries from package.json's dependencies or devDependencies>
- **Spurious entries found:** <should be "none"; if any, list them as a finding>

## v0.1.1 baseline for comparison

v0.1.1 dogfood produced 32 dep candidates, of which the implementer noted only ~3 were genuine (the others were `name`, `description`, `scripts`, `bin`, etc.). v0.1.2 expected: only genuine dep entries.

## Verdict

<one of:>
- ✓ Regression confirmed fixed. No spurious dep candidates.
- ✗ Spurious entries still appearing: <list>. Hold the release until investigated.

## Acceptance criteria from spec §1

| # | Criterion | Result |
|---|---|---|
| 1 | 81 tests pass, 1 skipped | <yes/no> |
| 2 | Zero spurious dep candidates in dogfood | <yes/no> |
| 3 | npm test, build, lint all exit 0 | <yes/no> |
| 4 | CHANGELOG.md has v0.1.2 entry | yes |
| 5 | 04-v011-dogfood.md AC3 corrected | yes |
| 6 | smol-toml install footprint <50KB | <yes/no — fill in actual size> |
```

Fill in actual values from Task 3. Be honest — if anything is still wrong, document it.

### Step 5: Verify the AC3 wording change took effect

```bash
cd /c/Glean && grep -E "PARTIAL|yes" docs/open-work/04-v011-dogfood.md | head -5
```
Expected: the AC3 row shows `PARTIAL`. Other rows are unchanged.

### Step 6: Run full suite once more

```bash
cd /c/Glean && npm test 2>&1 | tail -10
```
Expected: 81 + 1 skip.

### Step 7: Commit

```bash
cd /c/Glean && git add package.json CHANGELOG.md docs/open-work/04-v011-dogfood.md docs/open-work/05-v012-dogfood.md && git commit -m "chore: bump version to 0.1.2, add CHANGELOG and v0.1.2 dogfood doc; fix v0.1.1 AC3 wording"
```

---

## Task 5: Merge, tag, push

**Files:** none (git operations)

- [ ] **Step 1: Switch to main, merge v0.1.2**

```bash
cd /c/Glean && git checkout main
git merge --no-ff v0.1.2 -m "Merge v0.1.2 dep-parser patch into main"
git log --oneline --graph -10
```
Expected: clean fast-forward-with-merge-commit. HEAD on main now includes the v0.1.2 work.

- [ ] **Step 2: Tag v0.1.2 at the merge commit**

```bash
cd /c/Glean && git tag -a v0.1.2 -m "Glean v0.1.2 — dep-parser quality patch"
git show v0.1.2 --stat | head -5
```

- [ ] **Step 3: Push branch + tag to origin**

```bash
cd /c/Glean && git push origin main
git push origin v0.1.2
```

If push is rejected for any reason, STOP and report BLOCKED — don't force-push.

- [ ] **Step 4: Confirm remote state**

```bash
cd /c/Glean && git ls-remote origin | head -5
```
Expected: HEAD and main point at the merge commit; `v0.1.2` tag listed.

- [ ] **Step 5: Verify on GitHub**

Open `https://github.com/Jonny-boy9000/glean/releases` and confirm `v0.1.2` appears.

---

## Final sanity check

- [ ] **Step 1: Verify clean state on main**

```bash
cd /c/Glean && git status
cd /c/Glean && git tag -l "v0.*"
cd /c/Glean && git log --oneline --graph -10
```
Expected: clean working tree; tags `v0.1.0-mvp`, `v0.1.1`, `v0.1.2` all present; the v0.1.2 branch visible in graph merged into main.

- [ ] **Step 2: Verify acceptance criteria from spec §1**

Re-read `docs/open-work/05-v012-dogfood.md` and confirm all 6 acceptance criteria are checked off (or honestly documented as not-met).

---

## Notes for the implementer

- **Read the spec first.** Spec at `docs/superpowers/specs/2026-05-25-glean-v012-dep-parser-design.md` has the full rationale and per-format scoping rules. This plan is the mechanical execution; if it disagrees with the spec, escalate.
- **TDD strictly.** Task 2 writes the 3 new failing tests BEFORE the parser rewrite. Don't skip the "verify FAIL" step — it confirms the tests actually exercise what they claim.
- **The 2 existing discover-deps tests are preserved.** They should continue to pass after the rewrite — the new flow happens to produce the same outcome for those fixtures (`lodash` → `lodash, zod` after add → emits only `zod`). If they fail, debug before continuing.
- **smol-toml is the only new runtime dep.** Don't add anything else.
- **The `git show <commit>^:<path>` invocation will fail when `<commit>` is the initial commit** (no parent). `gitShowAtParent` catches this and returns `''`. Don't try to "fix" the error — the empty string is the correct signal that "nothing existed before this commit."
- **One commit per task that produces code.** Task 2 → one commit (parser + tests + new dep). Task 4 → one commit (version + CHANGELOG + AC3 + dogfood doc). Task 5 → no commits, just merge + tag + push.
- **Dogfood in Task 3 informs Task 4's doc.** Do them in order — don't write the dogfood doc with placeholder values.

---

## Spec coverage map

| Spec section | Tasks |
|---|---|
| §1 success criteria | Tasks 3 (validation) + 4 (doc), confirmed in Task 5 sanity check |
| §2 locked decisions | All tasks (decisions encoded in implementation) |
| §3 architecture | Task 2 (rewrite implements the full-file parse flow) |
| §4 module changes | Task 2 (src changes), Task 4 (admin changes) |
| §5 detailed behavior | Task 2 (all parsers + git helpers + discoverDeps) |
| §6 testing strategy | Task 2 (3 new tests + run full suite), Task 3 (manual validation) |
| §7 rollout | Task 1 (branch), Task 4 (commit 2), Task 5 (merge+tag+push) |
| §8 out of scope | (no tasks — intentional) |
