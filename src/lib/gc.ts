import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// CLAUDE.md §5.6: draft-impl worktrees + prep/glean-* branches expire after 21
// days. Because each run mints a fresh uuid for c.id, the per-run pre-provision
// cleanup never matches a prior run's path/branch — so without this sweep every
// draft-impl run would leak a permanently-registered worktree + branch.
export const WORKTREE_EXPIRY_MS = 21 * 24 * 60 * 60 * 1000;

// The draft-impl worktree dir is `<gleanRoot>/work/<slug>-<id>` and the branch
// is `prep/glean-<id>`. The id is the trailing token after the last '-'.
function prepBranchFor(dirName: string): string | null {
  const id = dirName.slice(dirName.lastIndexOf('-') + 1);
  return id ? `prep/glean-${id}` : null;
}

// Remove draft-impl worktrees whose backing dir is older than the expiry, plus
// their prep branches. Best-effort: every step is wrapped so a failure on one
// worktree (or a bad main repo) never throws — gc must never break a run.
// Returns the list of removed worktree dirs (for logging/tests).
export function gcWorktrees(main: string, gleanRoot: string, now: number): string[] {
  const removed: string[] = [];
  const workDir = join(gleanRoot, 'work');
  if (!existsSync(workDir)) return removed;

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
    const branch = prepBranchFor(name);
    if (branch) {
      try { execFileSync('git', ['-C', main, 'branch', '-D', branch], { stdio: 'ignore' }); } catch { /* may not exist */ }
    }
    removed.push(dir);
  }
  return removed;
}
