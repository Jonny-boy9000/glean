import { describe, it, expect } from 'vitest';
import { fingerprintCandidate } from './memory.js';

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
