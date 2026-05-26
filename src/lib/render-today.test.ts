/* eslint-disable no-control-regex */
import { describe, it, expect } from 'vitest';
import { renderToday } from './render-today.js';
import type { TodayReport } from './today.js';

describe('renderToday', () => {
  it('renders the empty-case message when no projects', () => {
    const r: TodayReport = { date: '2026-05-26', projects: [] };
    expect(renderToday(r, false)).toBe('No glean dossiers for 2026-05-26.');
  });

  it('renders a single project plain (no ANSI codes)', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        project_path: 'C:\\Glean',
        entries: [
          { title: 'Handle TODO in src/a.ts', status: 'ok', output: 'C:\\Users\\u\\glean\\dossiers\\glean\\2026-05-26\\research-handle-todo-a-L1\\OUT.md', type: 'research-dossier' },
          { title: 'Pre-fetch docs for lodash', status: 'ok-fallback', output: 'C:\\Users\\u\\glean\\dossiers\\glean\\2026-05-26\\docs\\lodash.md', type: 'fetch-docs' },
          { title: 'Bad task', status: 'failed', output: '', type: 'research-dossier' },
        ],
      }],
    };
    const s = renderToday(r, false);
    expect(s).not.toMatch(/\x1b\[/); // no ANSI escapes
    expect(s).toContain('GLEAN today — 2026-05-26');
    expect(s).toContain('▸ glean');
    expect(s).toContain('3 tasks');
    expect(s).toContain('✓ ok');
    expect(s).toContain('✓ ok-fallback');
    expect(s).toContain('✗ failed');
    expect(s).toContain('Handle TODO in src/a.ts');
    expect(s).toContain('(no output)');
  });

  it('renders with ANSI color codes when useColor is true', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'foo',
        entries: [
          { title: 'ok task', status: 'ok', output: 'OUT.md', type: 'research-dossier' },
          { title: 'bad task', status: 'failed', output: '', type: 'research-dossier' },
        ],
      }],
    };
    const s = renderToday(r, true);
    expect(s).toMatch(/\x1b\[1m/); // bold (header + project line)
    expect(s).toMatch(/\x1b\[32m/); // green for ok
    expect(s).toMatch(/\x1b\[31m/); // red for failed
    expect(s).toMatch(/\x1b\[2m/);  // dim for paths
  });

  it('replaces gleanRoot prefix with ~/glean in output paths', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [
          { title: 't', status: 'ok', output: 'C:\\Users\\u\\glean\\dossiers\\glean\\2026-05-26\\x\\OUT.md', type: 'research-dossier' },
        ],
      }],
    };
    const s = renderToday(r, false);
    expect(s).toContain('~/glean/dossiers/glean/2026-05-26/x/OUT.md');
    expect(s).not.toContain('C:\\Users\\u\\glean\\dossiers');
  });
});

describe('renderToday enrichment line', () => {
  it('appends a third line with duration, bytes, and rating (plain mode)', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'Handle TODO',
          status: 'ok',
          output: 'C:\\u\\glean\\dossiers\\g\\OUT.md',
          type: 'research-dossier',
          task_id: 't1',
          duration_ms: 720_000,    // 12m
          bytes_written: 4300,     // 4.2KB
          user_rating: 'kept',
        }],
      }],
    };
    const s = renderToday(r, false);
    expect(s).toContain('12m');
    expect(s).toContain('4.2KB');
    expect(s).toContain('rated: kept');
    expect(s).toMatch(/12m\s*·\s*4\.2KB\s*·\s*rated: kept/);
  });

  it('omits the enrichment line when no fields apply', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'No data',
          status: 'ok',
          output: 'OUT.md',
          type: 'research-dossier',
          task_id: 't2',
        }],
      }],
    };
    const s = renderToday(r, false);
    expect(s).not.toContain('·');
    expect(s).not.toContain('rated:');
  });

  it('emits red ANSI for a discarded rating in color mode', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'Bad',
          status: 'ok',
          output: 'OUT.md',
          type: 'research-dossier',
          task_id: 't3',
          duration_ms: 30_000,
          user_rating: 'discarded',
        }],
      }],
    };
    const s = renderToday(r, true);
    expect(s).toMatch(/\x1b\[31m.*rated: discarded.*\x1b\[0m/);
  });

  it('omits enrichment line for failed entries with no output', () => {
    const r: TodayReport = {
      date: '2026-05-26',
      projects: [{
        project_slug: 'glean',
        entries: [{
          title: 'Bad task',
          status: 'failed',
          output: '',
          type: 'research-dossier',
          task_id: 't4',
          duration_ms: 30_000,
        }],
      }],
    };
    const s = renderToday(r, false);
    expect(s).toContain('(no output)');
    expect(s).not.toMatch(/30s|30\s*·/);
  });
});
