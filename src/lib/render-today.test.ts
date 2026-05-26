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
