import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 11: glean repair recovers empty OUT.md from jsonl log', () => {
  it('rewrites a 22-byte OUT.md with extracted assistant text', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v11-home-'));
    const today = new Date().toISOString().slice(0, 10);
    const dossierDir = join(home, 'glean', 'dossiers', 'proj', today, 'research-foo');
    const logsDir = join(home, 'glean', 'logs', 'test-run');
    mkdirSync(dossierDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    writeFileSync(join(dossierDir, 'OUT.md'), '_(no output produced)_');
    writeFileSync(join(home, 'glean', 'dossiers', 'proj', today, 'INDEX.md'),
      `---
run_id: test-run
project_path: C:\\proj
generated_at: ${new Date().toISOString()}
entries:
  - { task_id: task-foo, evidence_hash: h, type: research-dossier, title: t, output: research-foo/OUT.md, status: ok-fallback }
---
# index
`);
    writeFileSync(join(logsDir, 'task-foo.jsonl'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(300) }] } }) + '\n');

    const res = spawnSync('node', ['bin/glean.js', 'repair', '--days', '30'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(statSync(join(dossierDir, 'OUT.md')).size).toBeGreaterThan(99);
    const idx = readFileSync(join(home, 'glean', 'dossiers', 'proj', today, 'INDEX.md'), 'utf8');
    expect(idx).toContain('ok-repaired');
  });
});
