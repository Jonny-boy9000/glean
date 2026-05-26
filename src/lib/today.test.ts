import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTodayDossiers } from './today.js';

function makeIndex(root: string, slug: string, date: string, entries: Array<{ title: string; status: string; output: string; type: string; task_id?: string }>, projectPath?: string): void {
  const dir = join(root, 'dossiers', slug, date);
  mkdirSync(dir, { recursive: true });
  const frontmatter = {
    run_id: 'run-x',
    project_path: projectPath ?? `C:\\projects\\${slug}`,
    generated_at: '2026-05-26T10:00:00.000Z',
    entries,
  };
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => k === 'entries'
      ? `entries:\n${(v as typeof entries).map((e, i) => `  - title: ${JSON.stringify(e.title)}\n    status: ${e.status}\n    output: ${JSON.stringify(e.output)}\n    type: ${e.type}\n    task_id: ${JSON.stringify(e.task_id ?? `task-${i + 1}`)}`).join('\n')}`
      : `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  writeFileSync(join(dir, 'INDEX.md'), `---\n${yaml}\n---\n\n# body ignored\n`);
}

describe('findTodayDossiers', () => {
  it('returns empty when dossiers directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-empty-'));
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r).toEqual({ date: '2026-05-26', projects: [] });
  });

  it('returns one project group when one INDEX exists for the target date', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-1-'));
    makeIndex(root, 'foo', '2026-05-26', [
      { title: 'Handle TODO in src/a.ts', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
      { title: 'Pre-fetch docs for lodash', status: 'ok', output: 'lodash.md', type: 'fetch-docs' },
    ]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.date).toBe('2026-05-26');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].project_slug).toBe('foo');
    expect(r.projects[0].entries).toHaveLength(2);
    expect(r.projects[0].entries[0].title).toBe('Handle TODO in src/a.ts');
    expect(r.projects[0].entries[0].status).toBe('ok');
  });

  it('filters to the target date and sorts projects alphabetically', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-multi-'));
    makeIndex(root, 'zebra', '2026-05-26', [{ title: 't1', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    makeIndex(root, 'alpha', '2026-05-26', [{ title: 't2', status: 'failed', output: '', type: 'research-dossier' }]);
    makeIndex(root, 'beta', '2026-05-25', [{ title: 'yesterday', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects.map((p) => p.project_slug)).toEqual(['alpha', 'zebra']);
  });

  it('skips a project with corrupt frontmatter without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-corrupt-'));
    const dir = join(root, 'dossiers', 'broken', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), 'no frontmatter here, just text\n');
    makeIndex(root, 'good', '2026-05-26', [{ title: 't', status: 'ok', output: 'OUT.md', type: 'research-dossier' }]);
    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects.map((p) => p.project_slug)).toEqual(['good']);
  });
});

describe('findTodayDossiers task_id preservation', () => {
  it('preserves task_id from INDEX frontmatter on each entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-taskid-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'project_path: C:\\proj',
      'generated_at: 2026-05-26T10:00:00.000Z',
      'entries:',
      '  - task_id: "task-abc"',
      '    title: "First"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '  - task_id: "task-def"',
      '    title: "Second"',
      '    status: ok',
      '    output: "B.md"',
      '    type: fetch-docs',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0].entries).toHaveLength(2);
    expect(r.projects[0].entries[0].task_id).toBe('task-abc');
    expect(r.projects[0].entries[1].task_id).toBe('task-def');
  });

  it('skips entries that lack task_id (validation guard)', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-today-notask-'));
    const dir = join(root, 'dossiers', 'proj', '2026-05-26');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'INDEX.md'), [
      '---',
      'run_id: r-1',
      'entries:',
      '  - title: "Has task_id"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '    task_id: "task-x"',
      '  - title: "No task_id"',
      '    status: ok',
      '    output: "OUT.md"',
      '    type: research-dossier',
      '---',
      '',
    ].join('\n'));

    const r = findTodayDossiers(root, '2026-05-26');
    expect(r.projects[0].entries).toHaveLength(1);
    expect(r.projects[0].entries[0].task_id).toBe('task-x');
  });
});
