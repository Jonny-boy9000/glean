import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 9: gh missing — pipeline completes without gh, produces TODO candidates', () => {
  it('exits 0 and candidates.json has at least one todo candidate when gh is broken', () => {
    // Setup repo with a TODO
    const repo = mkdtempSync(join(tmpdir(), 'glean-v9-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: gh-missing-test\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));

    // Create a stub gh that exits 1 (simulates gh not being authenticated / missing)
    const ghStubDir = mkdtempSync(join(tmpdir(), 'glean-gh-stub-'));
    if (process.platform === 'win32') {
      writeFileSync(join(ghStubDir, 'gh.cmd'), '@echo off\r\nexit /b 1\r\n');
      writeFileSync(join(ghStubDir, 'gh.bat'), '@echo off\r\nexit /b 1\r\n');
    } else {
      const ghScript = join(ghStubDir, 'gh');
      writeFileSync(ghScript, '#!/bin/sh\nexit 1\n');
      chmodSync(ghScript, 0o755);
    }

    const pathSep = process.platform === 'win32' ? ';' : ':';
    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      // Prepend stub dir so broken gh is found first
      PATH: `${ghStubDir}${pathSep}${process.env.PATH ?? ''}`,
    } as NodeJS.ProcessEnv;

    // Use --dry-run for speed (no claude needed)
    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m', '--dry-run'], {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(res.status).toBe(0);

    const stateDir = join(home, 'glean', 'state');
    const runs = readdirSync(stateDir).filter((f) => f !== 'RUN.lock');
    expect(runs.length).toBe(1);

    const candPath = join(stateDir, runs[0], 'candidates.json');
    expect(existsSync(candPath)).toBe(true);

    const cands = JSON.parse(readFileSync(candPath, 'utf8'));
    expect(cands.ranked.length).toBeGreaterThan(0);

    // At least one candidate must be a TODO (not a PR candidate)
    const todoCandidate = cands.ranked.find(
      (c: { evidence: { kind: string } }) => c.evidence.kind === 'todo',
    );
    expect(todoCandidate).toBeDefined();
  });
}, { timeout: 30_000 });
