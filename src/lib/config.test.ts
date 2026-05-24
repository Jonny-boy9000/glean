import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'glean-config-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, content);
  return p;
}

describe('loadConfig', () => {
  it('returns empty defaults when file is missing', () => {
    expect(loadConfig('Z:/does-not-exist/config.json')).toEqual({});
  });

  it('parses valid config', () => {
    const p = tmpFile(JSON.stringify({
      claude_bin: 'C:\\Program Files\\claude\\claude.exe',
      projects: { 'C:\\Glean': { base_branch: 'main' } },
    }));
    const cfg = loadConfig(p);
    expect(cfg.claude_bin).toBe('C:\\Program Files\\claude\\claude.exe');
    expect(cfg.projects?.['C:\\Glean']?.base_branch).toBe('main');
  });

  it('throws on malformed JSON', () => {
    const p = tmpFile('{not json');
    expect(() => loadConfig(p)).toThrow(/JSON/);
  });

  it('throws on schema violation with field path', () => {
    const p = tmpFile(JSON.stringify({ claude_bin: 123 }));
    expect(() => loadConfig(p)).toThrow(/claude_bin/);
  });
});
