import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDeps } from './discover-deps.js';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'glean-deps-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ dependencies: { lodash: '^4.0.0' } }, null, 2),
  );
  execSync('git add . && git commit -q -m init', { cwd: repo });
  // Add a new dep in a follow-up commit
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ dependencies: { lodash: '^4.0.0', zod: '^3.22.0' } }, null, 2),
  );
  execSync('git add . && git commit -q -m "add zod"', { cwd: repo });
});

describe('discoverDeps', () => {
  it('emits one candidate per recently-added package.json entry', async () => {
    const cands = await discoverDeps(repo);
    const packages = cands.map((c) => (c.evidence as any).package);
    expect(packages).toContain('zod');
    expect(packages).not.toContain('lodash'); // present at init, not newly added
  });

  it('emits candidates from a manifest that was ADDED in the last 14 days (not modified)', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-deps-new-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t', { cwd: r });
    execSync('git config user.name t', { cwd: r });
    writeFileSync(join(r, 'README.md'), 'x');
    execSync('git add . && git commit -q -m init', { cwd: r });
    writeFileSync(join(r, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.0.0' } }, null, 2));
    execSync('git add . && git commit -q -m "add package.json"', { cwd: r });

    const cands = await discoverDeps(r);
    const packages = cands.map(c => (c.evidence as { package: string }).package);
    expect(packages).toContain('lodash');
  });
});
