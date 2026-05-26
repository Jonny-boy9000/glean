import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('verification 15: glean today CLI', () => {
  it('prints a grouped report when dossiers exist for today', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v15-home-'));
    const today = localDateString(new Date());
    const dossierDir = join(home, 'glean', 'dossiers', 'demoproj', today);
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'project_path: C:\\demoproj',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - title: "Handle TODO in src/a.ts"',
      '    status: ok',
      '    output: "C:\\\\Users\\\\u\\\\glean\\\\dossiers\\\\demoproj\\\\' + today + '\\\\x\\\\OUT.md"',
      '    type: research-dossier',
      '---',
      '',
      '# body ignored',
      '',
    ].join('\n'));

    const res = spawnSync('node', ['bin/glean.js', 'today'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`GLEAN today — ${today}`);
    expect(res.stdout).toContain('▸ demoproj');
    expect(res.stdout).toContain('1 tasks');
    expect(res.stdout).toContain('Handle TODO in src/a.ts');
    expect(res.stdout).toContain('ok');
  });

  it('prints the empty-case message when no dossiers exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v15-empty-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const res = spawnSync('node', ['bin/glean.js', 'today'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    const today = localDateString(new Date());
    expect(res.stdout).toContain(`No glean dossiers for ${today}.`);
  });
});

function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
