/* eslint-disable no-control-regex */
import { describe, it, expect } from 'vitest';
import { renderRateList } from './rate.js';

type Row = {
  id: number;
  title: string;
  candidate_type: 'research-dossier' | 'fetch-docs';
  ended_at: number;
  dossier_path: string;
  user_rating: 'kept' | 'discarded' | 'actioned' | null;
};

describe('renderRateList', () => {
  it('renders the empty-case message when no rows', () => {
    expect(renderRateList([], false)).toBe('No ratable dossiers found.');
  });

  it('renders a plain table with no ANSI codes', () => {
    const rows: Row[] = [
      { id: 42, title: 'Handle TODO in src/cli.ts', candidate_type: 'research-dossier',
        ended_at: new Date('2026-05-26T13:01:00Z').getTime(), dossier_path: 'C:\\u\\glean\\dossiers\\g\\OUT.md', user_rating: 'kept' },
      { id: 41, title: 'Pre-fetch docs for better-sqlite3', candidate_type: 'fetch-docs',
        ended_at: new Date('2026-05-26T12:58:00Z').getTime(), dossier_path: 'C:\\u\\glean\\dossiers\\g\\docs\\bs3.md', user_rating: null },
      { id: 40, title: 'Handle TODO in src/foo.ts', candidate_type: 'research-dossier',
        ended_at: new Date('2026-05-25T10:13:00Z').getTime(), dossier_path: 'C:\\u\\glean\\dossiers\\g\\OUT.md', user_rating: 'discarded' },
    ];
    const s = renderRateList(rows, false);
    expect(s).not.toMatch(/\x1b\[/);
    expect(s).toContain('Recent rateable dossiers');
    expect(s).toContain('42');
    expect(s).toContain('41');
    expect(s).toContain('40');
    expect(s).toContain('research-dossier');
    expect(s).toContain('fetch-docs');
    expect(s).toContain('kept');
    expect(s).toContain('discarded');
    expect(s).toContain('(unrated)');
    expect(s).toContain('Handle TODO in src/cli.ts');
    expect(s).toContain('Rate one with: glean rate <id>');
  });

  it('emits ANSI codes when useColor is true', () => {
    const rows: Row[] = [
      { id: 1, title: 'kept', candidate_type: 'research-dossier',
        ended_at: Date.now(), dossier_path: 'OUT.md', user_rating: 'kept' },
      { id: 2, title: 'bad', candidate_type: 'research-dossier',
        ended_at: Date.now(), dossier_path: 'OUT.md', user_rating: 'discarded' },
      { id: 3, title: 'pending', candidate_type: 'research-dossier',
        ended_at: Date.now(), dossier_path: 'OUT.md', user_rating: null },
    ];
    const s = renderRateList(rows, true);
    expect(s).toMatch(/\x1b\[1m/);
    expect(s).toMatch(/\x1b\[32m/);
    expect(s).toMatch(/\x1b\[31m/);
    expect(s).toMatch(/\x1b\[2m/);
  });
});
