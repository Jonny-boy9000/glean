import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { researchAllowedTools, BASE_DENY } from '../../src/lib/deny.js';

const FAKE_CLAUDE = process.platform === 'win32'
  ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
  : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');

function scenario(name: string): string {
  return join(process.cwd(), 'test', 'fixtures', 'scenarios', name);
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'glean-v23-'));
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), '// TODO: research this real thing\n');
  execSync('git add . && git commit -q -m init', { cwd: repo });
  return repo;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'glean-v23-home-'));
  mkdirSync(join(home, 'glean'), { recursive: true });
  writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: FAKE_CLAUDE }));
  return home;
}

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

// Tokenize an --allowedTools string keeping Bash(...) specs intact.
function allowTokens(s: string): string[] {
  return s.match(/Bash\([^)]*\)|\S+/g) ?? [];
}

describe('verification 23: research-dossier read-access + read-only allow-list (ADR-0002)', () => {
  it('spawns with project read-scope, a read-only allow-list, and captures the dossier from the stream', () => {
    const repo = makeRepo();
    const home = makeHome();
    const argvOut = join(home, 'argv.jsonl');

    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        FAKE_CLAUDE_SCENARIO: scenario('research-readonly.yaml'),
        FAKE_CLAUDE_ARGV_OUT: argvOut,
      },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);

    // The research-dossier spawn's argv (first invocation that is NOT a draft-impl;
    // here all candidates are research-dossier).
    expect(existsSync(argvOut)).toBe(true);
    const invocations = readFileSync(argvOut, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as string[]);
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    const argv = invocations[0];

    // --- P1 safety proof: read-scope to BOTH the dossier dir and the project ---
    const addDirs: string[] = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '--add-dir') addDirs.push(argv[i + 1]);
    }
    // Project path is granted as a read dir.
    expect(addDirs.map((d) => resolve(d))).toContain(resolve(repo));
    // The dossier output dir (research-<slug>) is also granted.
    expect(addDirs.some((d) => /[\\/]research-/.test(d))).toBe(true);
    // At least two distinct --add-dir values were emitted.
    expect(new Set(addDirs.map((d) => resolve(d))).size).toBeGreaterThanOrEqual(2);

    // --- P1 safety proof: allow-list is exactly researchAllowedTools() ---
    const allowIdx = argv.indexOf('--allowedTools');
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    const allow = argv[allowIdx + 1];
    expect(allow).toBe(researchAllowedTools());

    // No bare Bash, no Edit/Write in the allow-list.
    const tokens = allowTokens(allow);
    expect(tokens).not.toContain('Bash');
    expect(allow).not.toContain('Edit');
    expect(allow).not.toContain('Write');

    // --- F2 safety proof: the deny-list actually reaches the spawn argv ---
    // The deny CONSTANT is unit-tested in deny.test.ts, but nothing proved it is
    // passed through to `claude -p`. This guards the executor refactor: if a
    // future change drops --disallowedTools, this fails loudly.
    const denyIdx = argv.indexOf('--disallowedTools');
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(argv[denyIdx + 1]).toBe(BASE_DENY);

    // --- Case 5: OUT.md is reconstructed from the multi-block final message ---
    const dossiers = join(home, 'glean', 'dossiers');
    const outPath = findOutMd(dossiers);
    expect(outPath).not.toBeNull();
    const body = readFileSync(outPath!, 'utf8');
    // Both text blocks concatenated, thinking block excluded.
    expect(body).toContain('# Research dossier');
    expect(body).toContain('## Findings');
    expect(body).toContain('a real observation from reading the code');
    expect(body).not.toContain('private reasoning');
  });
});
