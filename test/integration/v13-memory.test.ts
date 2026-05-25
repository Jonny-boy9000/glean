import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

describe('verification 13: memory substrate end-to-end', () => {
  it('writes runs and candidates rows during a full glean run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'glean-v13-'));
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@t', { cwd: repo });
    execSync('git config user.name t', { cwd: repo });
    writeFileSync(join(repo, 'a.ts'), '// TODO: real thing\n');
    execSync('git add . && git commit -q -m i', { cwd: repo });

    const home = mkdtempSync(join(tmpdir(), 'glean-v13-home-'));
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

    const dbPath = join(home, 'glean', 'memory.db');
    expect(existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const runs = db.prepare('SELECT * FROM runs').all() as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0].project_path).toBe(repo);
    expect(runs[0].exit_reason).toBe('completed');
    expect(runs[0].ended_at).not.toBeNull();
    expect(runs[0].glean_version).toMatch(/^\d+\.\d+\.\d+/);

    const candidates = db.prepare('SELECT * FROM candidates ORDER BY priority_rank').all() as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.run_id).toBe(runs[0].run_id);
      expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(c.outcome).not.toBeNull();
      // candidate_slug is c.id from discovery, which is a UUID v4
      expect(c.candidate_slug).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    db.close();
  });
});
