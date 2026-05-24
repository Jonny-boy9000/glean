import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function findOutMd(dir: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const r = findOutMd(p);
      if (r) return r;
    } else if (e.name === 'OUT.md') return p;
  }
  return null;
}

describe('verification 2: full task end-to-end via fake-claude', () => {
  it('produces an OUT.md ≥50 bytes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v2-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: actual thing\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
    const fakeClaude = process.platform === 'win32'
      ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
      : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
    const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml');

    mkdirSync(join(home, 'glean'), { recursive: true });
    writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    const dossiers = join(home, 'glean', 'dossiers');
    expect(existsSync(dossiers)).toBe(true);
    const found = findOutMd(dossiers);
    expect(found).not.toBeNull();
    expect(statSync(found!).size).toBeGreaterThan(49);
  });
});
