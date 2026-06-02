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

  // v0.8.2 item 1: configurable circuit-breaker threshold on drain_trigger.
  it('parses drain_trigger.max_unproductive', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { max_unproductive: 5 } }));
    const cfg = loadConfig(p);
    expect(cfg.drain_trigger?.max_unproductive).toBe(5);
  });

  it('leaves max_unproductive undefined when absent (inert default)', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { day: 'Friday' } }));
    const cfg = loadConfig(p);
    expect(cfg.drain_trigger?.max_unproductive).toBeUndefined();
  });

  it('rejects a non-numeric max_unproductive', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { max_unproductive: 'lots' } }));
    expect(() => loadConfig(p)).toThrow(/max_unproductive/);
  });

  // v0.8.2 item 3: anti-spill pre-emptive margin on drain_trigger.
  it('parses drain_trigger.anti_spill_margin_minutes', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { anti_spill_margin_minutes: 30 } }));
    const cfg = loadConfig(p);
    expect(cfg.drain_trigger?.anti_spill_margin_minutes).toBe(30);
  });

  it('leaves anti_spill_margin_minutes undefined when absent (default 15 in runDrain)', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { day: 'Friday' } }));
    const cfg = loadConfig(p);
    expect(cfg.drain_trigger?.anti_spill_margin_minutes).toBeUndefined();
  });

  it('rejects a non-numeric anti_spill_margin_minutes', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { anti_spill_margin_minutes: 'soon' } }));
    expect(() => loadConfig(p)).toThrow(/anti_spill_margin_minutes/);
  });
});
