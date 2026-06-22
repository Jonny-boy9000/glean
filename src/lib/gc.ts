import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// CLAUDE.md §5.6: draft-impl worktrees + prep/glean-* branches expire after 21
// days. Because each run mints a fresh uuid for c.id, the per-run pre-provision
// cleanup never matches a prior run's path/branch — so without this sweep every
// draft-impl run would leak a permanently-registered worktree + branch.
export const WORKTREE_EXPIRY_MS = 21 * 24 * 60 * 60 * 1000;

// The draft-impl worktree dir is `<gleanRoot>/work/<slug>-<id>` and the branch
// is `prep/glean-<id>`, where <id> is a full UUID v4 that itself CONTAINS
// hyphens (e.g. 3f8a1c2b-9d4e-4f6a-b1c2-d3e4f5a6b7c8). The slug also contains
// hyphens, so `<slug>-<uuid>` cannot be split on '-' to recover the id — the
// previous lastIndexOf('-') heuristic recovered only the trailing UUID segment
// and `git branch -D prep/glean-<segment>` silently missed the real branch,
// leaking prep/glean-* branches forever. Instead we ask git for the authoritative
// path→branch mapping. Parse `git worktree list --porcelain`: each record is a
// `worktree <abs-path>` line optionally followed by `branch refs/heads/<name>`.
// Returns a Map keyed by the resolved absolute worktree path.
export function worktreeBranchMap(main: string): Map<string, string> {
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = execFileSync('git', ['-C', main, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  } catch {
    return map; // bad/absent repo — gc must never throw
  }
  let curPath: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      curPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ') && curPath) {
      const ref = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      map.set(resolve(curPath), ref);
    } else if (line === '') {
      curPath = null; // record separator
    }
  }
  return map;
}

// Remove draft-impl worktrees whose backing dir is older than the expiry, plus
// their prep branches. Best-effort: every step is wrapped so a failure on one
// worktree (or a bad main repo) never throws — gc must never break a run.
// Returns the list of removed worktree dirs (for logging/tests).
export function gcWorktrees(main: string, gleanRoot: string, now: number): string[] {
  const removed: string[] = [];
  const workDir = join(gleanRoot, 'work');
  if (!existsSync(workDir)) return removed;

  // Resolve each registered worktree's REAL branch BEFORE pruning/removing — the
  // mapping is git's source of truth, so it survives a UUID-with-hyphens id that
  // no string split could recover (F1). Built once up front; `worktree prune`
  // and `worktree remove` below only drop entries, never rename branches.
  const branchByPath = worktreeBranchMap(main);

  // Drop registrations whose backing dir already vanished.
  try { execFileSync('git', ['-C', main, 'worktree', 'prune'], { stdio: 'ignore' }); } catch { /* ignore */ }

  let entries: string[] = [];
  try { entries = readdirSync(workDir); } catch { return removed; }

  for (const name of entries) {
    // Glean scratch (prompts/logs) lives under work/.glean-scratch — never a worktree.
    if (name.startsWith('.')) continue;
    const dir = join(workDir, name);
    let mtimeMs: number;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch { continue; }

    if (now - mtimeMs < WORKTREE_EXPIRY_MS) continue; // fresh — keep

    // Stale: remove the worktree registration + dir, then delete its prep branch.
    try { execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', dir], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Authoritative branch from git's porcelain mapping (keyed by abs path).
    const branch = branchByPath.get(resolve(dir));
    if (branch) {
      try { execFileSync('git', ['-C', main, 'branch', '-D', branch], { stdio: 'ignore' }); } catch { /* may not exist */ }
    }
    removed.push(dir);
  }
  return removed;
}
