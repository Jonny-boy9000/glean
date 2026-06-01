import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcWorktrees, WORKTREE_EXPIRY_MS } from './gc.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'glean-gc-repo-'));
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), 'x\n');
  execSync('git add . && git commit -q -m init', { cwd: repo });
  return repo;
}

function ageDir(dir: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(dir, t, t);
}

describe('gcWorktrees (CRITICAL 2: 21-day worktree expiry)', () => {
  it('exposes a 21-day threshold', () => {
    expect(WORKTREE_EXPIRY_MS).toBe(21 * 24 * 60 * 60 * 1000);
  });

  it('removes a stale worktree + its prep branch, keeps a fresh one', () => {
    const repo = setupRepo();
    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-gc-root-'));
    const workDir = join(gleanRoot, 'work');
    mkdirSync(workDir, { recursive: true });

    const staleWt = join(workDir, 'stale-aaaa');
    const freshWt = join(workDir, 'fresh-bbbb');
    execSync(`git -C "${repo}" worktree add "${staleWt}" -b prep/glean-aaaa main`);
    execSync(`git -C "${repo}" worktree add "${freshWt}" -b prep/glean-bbbb main`);

    // Make the stale worktree look 22 days old; fresh stays new.
    ageDir(staleWt, 22 * 24 * 60 * 60 * 1000);

    const removed = gcWorktrees(repo, gleanRoot, Date.now());

    expect(removed).toContain(staleWt);
    expect(existsSync(staleWt)).toBe(false);
    expect(existsSync(freshWt)).toBe(true);

    // stale prep branch gone, fresh one kept
    const branches = execSync('git branch --list "prep/glean-*"', { cwd: repo, encoding: 'utf8' });
    expect(branches).not.toContain('prep/glean-aaaa');
    expect(branches).toContain('prep/glean-bbbb');
  });

  it('never throws — a missing work dir is a no-op', () => {
    const repo = setupRepo();
    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-gc-empty-'));
    expect(() => gcWorktrees(repo, gleanRoot, Date.now())).not.toThrow();
    expect(gcWorktrees(repo, gleanRoot, Date.now())).toEqual([]);
  });

  it('swallows errors from a bad main repo (never breaks a run)', () => {
    const gleanRoot = mkdtempSync(join(tmpdir(), 'glean-gc-bad-'));
    mkdirSync(join(gleanRoot, 'work', 'orphan-cccc'), { recursive: true });
    ageDir(join(gleanRoot, 'work', 'orphan-cccc'), 30 * 24 * 60 * 60 * 1000);
    const notARepo = mkdtempSync(join(tmpdir(), 'glean-gc-notrepo-'));
    expect(() => gcWorktrees(notARepo, gleanRoot, Date.now())).not.toThrow();
  });
});
