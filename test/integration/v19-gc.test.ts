import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpRepo(): string {
  const r = mkdtempSync(join(tmpdir(), 'glean-v19-'));
  execSync('git init -q -b main', { cwd: r });
  execSync('git config user.email t@t', { cwd: r });
  execSync('git config user.name t', { cwd: r });
  writeFileSync(join(r, 'a.ts'), '// TODO: thing\n');
  execSync('git add . && git commit -q -m i', { cwd: r });
  return r;
}

describe('verification 19: glean run gc-expires stale worktrees (CRITICAL 2)', () => {
  it('removes a 22-day-old prep worktree + branch on the next run', () => {
    const repo = tmpRepo();
    const home = mkdtempSync(join(tmpdir(), 'glean-v19-home-'));
    const workDir = join(home, 'glean', 'work');
    mkdirSync(workDir, { recursive: true });

    // Plant a stale draft-impl worktree from a "previous" run.
    const staleWt = join(workDir, 'old-task-zzzz');
    execSync(`git -C "${repo}" worktree add "${staleWt}" -b prep/glean-zzzz main`);
    const old = (Date.now() - 22 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(staleWt, old, old);

    // A dry run still hits the gc pass at pipeline start.
    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m', '--dry-run'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    expect(existsSync(staleWt)).toBe(false);
    const branches = execSync('git branch --list "prep/glean-*"', { cwd: repo, encoding: 'utf8' });
    expect(branches).not.toContain('prep/glean-zzzz');
  });
});
