import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export type DiffStat = { files: number; insertions: number; deletions: number };

// F4: use TWO-dot `base..branch` (branch-relative: what the prep branch added
// beyond base) for BOTH the diff stat and the commit count, so they answer the
// same "did anything land on the prep branch" question. Three-dot (symmetric)
// would fold in base-only changes when base has advanced past the branch point.
// All linked worktrees share one object store, so reading from the main dir
// works regardless of where the worktree lives (Windows-safe).
function diffStatImpl(main: string, base: string, branch: string): DiffStat | null {
  try {
    const out = execFileSync('git', ['-C', main, 'diff', '--numstat', `${base}..${branch}`], { encoding: 'utf8' });
    let files = 0, insertions = 0, deletions = 0;
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [ins, del] = line.split('\t');
      files++;
      insertions += Number(ins) || 0;
      deletions += Number(del) || 0;
    }
    return { files, insertions, deletions };
  } catch { return null; }
}

// Injectable wrappers so tests can force a parse failure (null stat) and verify
// it is surfaced rather than coerced into a clean 0-file success.
export function diffStat(main: string, base: string, branch: string): DiffStat | null {
  return diffStat.impl(main, base, branch);
}
diffStat.impl = diffStatImpl;

function commitsBeyondBaseImpl(main: string, base: string, branch: string): number {
  try {
    const out = execFileSync('git', ['-C', main, 'rev-list', '--count', `${base}..${branch}`], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}
export function commitsBeyondBase(main: string, base: string, branch: string): number {
  return commitsBeyondBase.impl(main, base, branch);
}
commitsBeyondBase.impl = commitsBeyondBaseImpl;

// Test-only handles (prefixed __ to signal "do not use in production code").
export const __diffStat = diffStat;
export const __commitsBeyondBase = commitsBeyondBase;
export const __clearStaleIndexLock = clearStaleIndexLock;

// Auto-commit fallback for when the session edited but did not commit.
//
// F3: we deliberately do NOT blanket-stage tracked modifications (`git add -u`).
// A test run inside the worktree can rewrite a TRACKED snapshot/lockfile that is
// unrelated to the TODO; `git add -u` would silently land it in the user's draft.
// Instead we scope staging to:
//   - the evidence file(s) for the TODO (the file the model was asked to change), and
//   - new (untracked) non-ignored source files the model created (honors
//     .gitignore + our .git/info/exclude, so prompt.md/OUT.md and coverage/dist
//     stay out).
// Other tracked files the model deliberately touched are still picked up: the
// model is instructed to `git add` them itself, and any it staged before the
// kill survive (we never `git reset`). This keeps the auto-commit set explicit —
// no unrelated or secret file lands silently. Best-effort: clean tree is a no-op.
export function autoCommitIfDirty(worktree: string, evidenceFiles: string[]): void {
  try {
    const status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' });
    if (!status.trim()) return;
    // Stage the evidence file(s) the model was asked to change (if present/dirty).
    for (const f of evidenceFiles) {
      if (!f) continue;
      try { execFileSync('git', ['-C', worktree, 'add', '--', f], { stdio: 'ignore' }); } catch { /* missing/clean */ }
    }
    // Stage untracked-but-not-ignored files explicitly (new source the model
    // created). --others --exclude-standard filters .gitignore + info/exclude.
    const untracked = execFileSync(
      'git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'],
      { encoding: 'utf8' },
    ).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const f of untracked) {
      execFileSync('git', ['-C', worktree, 'add', '--', f], { stdio: 'ignore' });
    }
    // If after staging there is nothing, skip the commit.
    const staged = execFileSync('git', ['-C', worktree, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
    if (!staged.trim()) return;
    execFileSync('git', ['-C', worktree, '-c', 'user.email=glean@local', '-c', 'user.name=glean', 'commit', '-m', 'glean: draft (review)'], { stdio: 'ignore' });
  } catch { /* best effort */ }
}

// Add glean scratch filenames to the worktree's .git/info/exclude so an
// auto-commit `git add` never sweeps them into the user's draft branch.
export function excludeFromWorktree(main: string, worktree: string, patterns: string[]): void {
  try {
    // --path-format=absolute returns the resolved path directly; joining the
    // worktree to a (Windows-)absolute --git-path result yields a garbage path.
    const excludePath = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
      { encoding: 'utf8' },
    ).trim();
    if (!excludePath) return;
    let existing = '';
    try { existing = readFileSync(excludePath, 'utf8'); } catch { /* new file */ }
    const toAdd = patterns.filter((p) => !existing.includes(p));
    if (toAdd.length) {
      mkdirSync(dirname(excludePath), { recursive: true });
      writeFileSync(excludePath, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + toAdd.join('\n') + '\n');
    }
  } catch { /* best effort */ }
}

// ASSUMPTION[ADR-0014]: link the base checkout's node_modules into the worktree so
// glean's OUT-OF-SESSION test run resolves declared deps — a Node/TS draft that would
// pass after `npm install` reaches 'pass' instead of a false 'env-blocked'. Created
// ONLY after the spawn tree is provably dead (descendantsDead) and never at
// worktree-add, so it does NOT widen the ADR-0009 boundary (the live spawn ran with
// cwd:worktree BEFORE this link existed and never saw base deps). Junction on Windows
// (needs no elevation, unlike a 'dir' symlink), dir-symlink on POSIX. Best-effort:
// NEVER throws; on any error the caller proceeds as today → 'env-blocked'. The caller
// tears the link down after the test run (rmSync, force, non-recursive — deletes only
// the reparse point, never the base node_modules it targets).
export function linkBaseNodeModules(
  main: string,
  worktree: string,
  descendantsDead: boolean,
): { linked: boolean; path: string | null } {
  const dst = join(worktree, 'node_modules');
  try {
    if (!descendantsDead) return { linked: false, path: null };   // belt-and-braces liveness gate
    if (existsSync(dst)) return { linked: false, path: dst };     // model already produced one — never clobber
    const src = join(main, 'node_modules');
    if (!existsSync(src)) return { linked: false, path: null };   // non-Node project — pure no-op
    symlinkSync(resolve(src), dst, process.platform === 'win32' ? 'junction' : 'dir');
    return { linked: true, path: dst };
  } catch {
    // EPERM (locked-down host) / EEXIST (race) / ENOSYS — degrade to today's behavior.
    return { linked: false, path: existsSync(dst) ? dst : null };
  }
}

// Remove a node_modules LINK created by linkBaseNodeModules — removes ONLY the link
// (POSIX dir-symlink via unlinkSync; Windows junction reparse point via rmdirSync),
// NEVER the base node_modules it targets. Critically does NOT use rmSync({recursive}):
// a Windows junction lstats as a directory, so a recursive remove could delete the
// base's contents. Best-effort, never throws.
export function unlinkNodeModulesLink(path: string): void {
  try { unlinkSync(path); return; } catch { /* not a POSIX symlink — try the Windows junction path */ }
  try { rmdirSync(path); } catch { /* best effort — leaves only a harmless link if it can't be removed */ }
}

// T8/F7: remove a STALE index.lock left by a killed/exited child so the
// auto-commit/diff steps don't fail with "Another git process seems to be
// running".
//
// F7 — DO NOT delete a lock a live process still holds. The real guarantee is
// the caller's precondition: runClaude has already awaited spawnInJob.kill()
// (descendant tree-kill complete) AND job.exit, so by the time this runs the
// entire spawned process tree is dead — any surviving lock is provably orphaned.
// That is a stronger, non-racy signal than a wall-clock age heuristic, which is
// why we gate on `descendantsDead` rather than guessing from mtime. We still log
// the lock age for diagnostics.
function clearStaleIndexLock(main: string, worktree: string, descendantsDead: boolean): void {
  if (!descendantsDead) return; // never touch a lock while a holder may be alive
  try {
    // --path-format=absolute makes the returned path unambiguous; git -C runs in
    // the worktree so this resolves to the linked worktree's own index.lock.
    const lockPath = execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
      { encoding: 'utf8' },
    ).trim();
    if (!lockPath || !existsSync(lockPath)) return;
    let ageMs = Infinity;
    try { ageMs = Date.now() - statSync(lockPath).mtimeMs; } catch { /* unknown age */ }
    rmSync(lockPath, { force: true });
    process.stderr.write(`[draft-impl] cleared stale index.lock in ${worktree} (age ${Number.isFinite(ageMs) ? Math.round(ageMs) + 'ms' : 'unknown'})\n`);
  } catch { /* best effort */ }
}

export { clearStaleIndexLock };
