import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpRepo(): string {
  const r = mkdtempSync(join(tmpdir(), 'glean-v1-'));
  execSync('git init -q', { cwd: r });
  execSync('git config user.email t@t', { cwd: r });
  execSync('git config user.name t', { cwd: r });
  writeFileSync(join(r, 'a.ts'), '// TODO: thing\n');
  execSync('git add . && git commit -q -m i', { cwd: r });
  return r;
}

describe('verification 1: --dry-run writes candidates.json and exits 0', () => {
  it('passes', () => {
    const repo = tmpRepo();
    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m', '--dry-run'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    const stateDir = join(home, 'glean', 'state');
    const runs = readdirSync(stateDir).filter((f) => f !== 'RUN.lock');
    expect(runs.length).toBe(1);
    const candPath = join(stateDir, runs[0], 'candidates.json');
    expect(existsSync(candPath)).toBe(true);
    const cands = JSON.parse(readFileSync(candPath, 'utf8'));
    expect(cands.ranked.length).toBeGreaterThan(0);
  });
});
