import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintCandidate } from './memory.js';
import { Memory } from './memory.js';

describe('fingerprintCandidate', () => {
  it('returns identical hash for identical input', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO in src/foo.ts',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO in src/foo.ts',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes whitespace and case in title', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO   in src/foo.ts',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'HANDLE todo IN SRC/FOO.TS',
    });
    expect(a).toBe(b);
  });

  it('produces different hash for different file_path', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/bar.ts',
      title: 'Handle TODO',
    });
    expect(a).not.toBe(b);
  });

  it('treats null file_path as empty string and is stable', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'fetch-docs',
      file_path: null,
      title: 'Pre-fetch docs for lodash',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'fetch-docs',
      file_path: null,
      title: 'Pre-fetch docs for lodash',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hash for different project_path', () => {
    const a = fingerprintCandidate({
      project_path: 'C:\\Glean',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO',
    });
    const b = fingerprintCandidate({
      project_path: 'C:\\OtherProject',
      candidate_type: 'research-dossier',
      file_path: 'src/foo.ts',
      title: 'Handle TODO',
    });
    expect(a).not.toBe(b);
  });
});

describe('Memory open + migrate', () => {
  it('creates the schema on a fresh DB and sets user_version=1', () => {
    const m = new Memory(':memory:');
    const rows = (m as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } })
      .db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    expect(rows).toEqual([{ name: 'candidates' }, { name: 'runs' }]);
    const v = (m as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(1);
    m.close();
  });

  it('is idempotent — opening twice does not error', () => {
    // Opening :memory: creates a fresh DB each time, so use a file path via tmpdir
    const dir = mkdtempSync(join(tmpdir(), 'glean-mem-'));
    const path = join(dir, 'memory.db');
    const m1 = new Memory(path);
    m1.close();
    const m2 = new Memory(path);
    const v = (m2 as unknown as { db: { pragma: (s: string, o: { simple: boolean }) => unknown } })
      .db.pragma('user_version', { simple: true });
    expect(v).toBe(1);
    m2.close();
  });
});
