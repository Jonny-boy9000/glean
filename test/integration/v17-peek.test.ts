import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function todayDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('verification 17: glean peek CLI', () => {
  it('prints the matching project dossier when run inside a repo with one', () => {
    // Set up a fake home with a dossier for slug 'demorepo'
    const home = mkdtempSync(join(tmpdir(), 'glean-v17-home-'));
    mkdirSync(join(home, 'glean'), { recursive: true });
    const dossierDir = join(home, 'glean', 'dossiers', 'demorepo', todayDate());
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'INDEX.md'), [
      '---',
      'run_id: r-v17',
      'project_path: C:\\demorepo',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - task_id: "task-v17"',
      '    title: "Peek test entry"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    // Set up a fake repo named 'demorepo' with .git
    const reposParent = mkdtempSync(join(tmpdir(), 'glean-v17-repos-'));
    const repoRoot = join(reposParent, 'demorepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    const res = spawnSync('node', [join(process.cwd(), 'bin', 'glean.js'), 'peek'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('demorepo');
    expect(res.stdout).toContain('Peek test entry');
  });

  it('prints empty stdout when cwd has no .git anywhere up', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v17-home-nogit-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const nonRepo = mkdtempSync(join(tmpdir(), 'glean-v17-nonrepo-'));

    const res = spawnSync('node', [join(process.cwd(), 'bin', 'glean.js'), 'peek'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      cwd: nonRepo,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('prints empty stdout when in a git repo with no matching dossier', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-v17-home-nodossier-'));
    mkdirSync(join(home, 'glean'), { recursive: true });

    const reposParent = mkdtempSync(join(tmpdir(), 'glean-v17-repos-'));
    const repoRoot = join(reposParent, 'demorepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));

    const res = spawnSync('node', [join(process.cwd(), 'bin', 'glean.js'), 'peek'], {
      env: { ...process.env, USERPROFILE: home, HOME: home },
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});
