import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, defaultConfigPath, setProjectPriority, effectivePriority } from './config.js';

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

  // ADR-0009: opt-in hard-close of the draft-impl in-session allow-list.
  it('parses strict_spawn', () => {
    const p = tmpFile(JSON.stringify({ strict_spawn: true }));
    expect(loadConfig(p).strict_spawn).toBe(true);
  });

  it('leaves strict_spawn undefined when absent (Narrow default)', () => {
    const p = tmpFile(JSON.stringify({ claude_bin: 'claude' }));
    expect(loadConfig(p).strict_spawn).toBeUndefined();
  });

  it('rejects a non-boolean strict_spawn', () => {
    const p = tmpFile(JSON.stringify({ strict_spawn: 'yes' }));
    expect(() => loadConfig(p)).toThrow(/strict_spawn/);
  });

  // ADR-0013: opt-in OS-sandbox enforcement.
  it('parses enforce_spawn', () => {
    const p = tmpFile(JSON.stringify({ enforce_spawn: true }));
    expect(loadConfig(p).enforce_spawn).toBe(true);
  });

  it('leaves enforce_spawn undefined when absent', () => {
    const p = tmpFile(JSON.stringify({ claude_bin: 'claude' }));
    expect(loadConfig(p).enforce_spawn).toBeUndefined();
  });

  it('rejects a non-boolean enforce_spawn', () => {
    const p = tmpFile(JSON.stringify({ enforce_spawn: 'yes' }));
    expect(() => loadConfig(p)).toThrow(/enforce_spawn/);
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

  // These are whole-unit quantities: max_unproductive is compared against an
  // integer counter, and a fractional margin is meaningless. A non-integer must
  // be rejected, not silently accepted (a 3.7 threshold would never trip the guard).
  it('rejects a fractional max_unproductive', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { max_unproductive: 3.7 } }));
    expect(() => loadConfig(p)).toThrow(/max_unproductive/);
  });

  it('rejects a fractional anti_spill_margin_minutes', () => {
    const p = tmpFile(JSON.stringify({ drain_trigger: { anti_spill_margin_minutes: 14.9 } }));
    expect(() => loadConfig(p)).toThrow(/anti_spill_margin_minutes/);
  });
});

// v0.9 project portfolio: per-project priority dial (off|low|normal|high).
describe('loadConfig projects.priority', () => {
  it('parses a per-project priority', () => {
    const p = tmpFile(JSON.stringify({
      projects: { 'C:\\Glean': { base_branch: 'main', priority: 'high' } },
    }));
    const cfg = loadConfig(p);
    expect(cfg.projects?.['C:\\Glean']?.priority).toBe('high');
  });

  it('leaves priority undefined when absent (backward compatible)', () => {
    const p = tmpFile(JSON.stringify({
      projects: { 'C:\\Glean': { base_branch: 'main' } },
    }));
    const cfg = loadConfig(p);
    expect(cfg.projects?.['C:\\Glean']?.priority).toBeUndefined();
  });

  it('rejects an unknown priority value', () => {
    const p = tmpFile(JSON.stringify({
      projects: { 'C:\\Glean': { priority: 'urgent' } },
    }));
    expect(() => loadConfig(p)).toThrow(/priority/);
  });
});

// v0.9 capacity governor: pacing config (gates the nightly preset; consumed
// by `glean usage` and recommendTier).
describe('loadConfig pacing', () => {
  it('parses pacing.enabled, pacing.haircut and pacing.thresholds', () => {
    const p = tmpFile(JSON.stringify({
      pacing: {
        enabled: false,
        haircut: 0.2,
        thresholds: { skip_above: 1.3, small_above: 0.9, normal_above: 0.4 },
      },
    }));
    const cfg = loadConfig(p);
    expect(cfg.pacing?.enabled).toBe(false);
    expect(cfg.pacing?.haircut).toBe(0.2);
    expect(cfg.pacing?.thresholds).toEqual({ skip_above: 1.3, small_above: 0.9, normal_above: 0.4 });
  });

  it('leaves pacing undefined when absent (backward compatible)', () => {
    const p = tmpFile(JSON.stringify({ claude_bin: 'claude' }));
    expect(loadConfig(p).pacing).toBeUndefined();
  });

  it('accepts partial thresholds (each bound is independently overridable)', () => {
    const p = tmpFile(JSON.stringify({ pacing: { thresholds: { skip_above: 1.5 } } }));
    const cfg = loadConfig(p);
    expect(cfg.pacing?.thresholds?.skip_above).toBe(1.5);
    expect(cfg.pacing?.thresholds?.small_above).toBeUndefined();
  });

  it('rejects a haircut outside 0..1', () => {
    expect(() => loadConfig(tmpFile(JSON.stringify({ pacing: { haircut: 1.5 } })))).toThrow(/haircut/);
    expect(() => loadConfig(tmpFile(JSON.stringify({ pacing: { haircut: -0.1 } })))).toThrow(/haircut/);
  });

  it('rejects a non-boolean enabled', () => {
    expect(() => loadConfig(tmpFile(JSON.stringify({ pacing: { enabled: 'no' } })))).toThrow(/enabled/);
  });
});

// PIECE 1 (#3): user-input subscription week anchor — pacing.week_anchor {day,time}.
describe('loadConfig pacing.week_anchor', () => {
  it('parses a valid week_anchor (day + HH:MM)', () => {
    const p = tmpFile(JSON.stringify({ pacing: { week_anchor: { day: 'Saturday', time: '03:00' } } }));
    const cfg = loadConfig(p);
    expect(cfg.pacing?.week_anchor).toEqual({ day: 'Saturday', time: '03:00' });
  });

  it('leaves week_anchor undefined when absent (backward compatible)', () => {
    const p = tmpFile(JSON.stringify({ pacing: { enabled: true } }));
    expect(loadConfig(p).pacing?.week_anchor).toBeUndefined();
  });

  it('rejects an invalid weekday name', () => {
    const p = tmpFile(JSON.stringify({ pacing: { week_anchor: { day: 'Funday', time: '03:00' } } }));
    expect(() => loadConfig(p)).toThrow(/week_anchor/);
  });

  it('rejects a malformed time', () => {
    const p = tmpFile(JSON.stringify({ pacing: { week_anchor: { day: 'Saturday', time: '3am' } } }));
    expect(() => loadConfig(p)).toThrow(/week_anchor/);
  });

  it('rejects an out-of-range time (25:00)', () => {
    const p = tmpFile(JSON.stringify({ pacing: { week_anchor: { day: 'Saturday', time: '25:00' } } }));
    expect(() => loadConfig(p)).toThrow(/week_anchor/);
  });
});

// PIECE 2: morning anti-spill buffer (opt-in; default 0 = off).
describe('loadConfig pacing.morning_buffer_hours', () => {
  it('parses a positive morning_buffer_hours', () => {
    const p = tmpFile(JSON.stringify({ pacing: { morning_buffer_hours: 2 } }));
    expect(loadConfig(p).pacing?.morning_buffer_hours).toBe(2);
  });

  it('accepts a fractional buffer (1.5h)', () => {
    const p = tmpFile(JSON.stringify({ pacing: { morning_buffer_hours: 1.5 } }));
    expect(loadConfig(p).pacing?.morning_buffer_hours).toBe(1.5);
  });

  it('leaves morning_buffer_hours undefined when absent (off by default)', () => {
    const p = tmpFile(JSON.stringify({ pacing: { enabled: true } }));
    expect(loadConfig(p).pacing?.morning_buffer_hours).toBeUndefined();
  });

  it('rejects a negative buffer', () => {
    const p = tmpFile(JSON.stringify({ pacing: { morning_buffer_hours: -1 } }));
    expect(() => loadConfig(p)).toThrow(/morning_buffer_hours/);
  });
});

// v0.9 model routing (ADR-0006): per-task-type model + max-turns maps, plus
// the pacing_promote list ('large' tier route-up eligibility).
describe('loadConfig model routing keys', () => {
  it('parses a models map keyed by task type (aliases or full ids)', () => {
    const p = tmpFile(JSON.stringify({
      models: { 'fetch-docs': 'haiku', 'research-dossier': 'claude-sonnet-4-5-20250929', 'draft-impl': 'sonnet' },
    }));
    const cfg = loadConfig(p);
    expect(cfg.models?.['fetch-docs']).toBe('haiku');
    expect(cfg.models?.['research-dossier']).toBe('claude-sonnet-4-5-20250929');
    expect(cfg.models?.['draft-impl']).toBe('sonnet');
  });

  it('leaves models undefined when absent (defaults applied at resolution time)', () => {
    const p = tmpFile(JSON.stringify({ claude_bin: 'claude' }));
    expect(loadConfig(p).models).toBeUndefined();
  });

  it('accepts a PARTIAL models map (unlisted types fall back to defaults)', () => {
    const p = tmpFile(JSON.stringify({ models: { 'draft-impl': 'opus' } }));
    const cfg = loadConfig(p);
    expect(cfg.models?.['draft-impl']).toBe('opus');
    expect(cfg.models?.['fetch-docs']).toBeUndefined();
  });

  it('rejects a models key that is not a known task type', () => {
    const p = tmpFile(JSON.stringify({ models: { 'draft-pr-reply': 'opus' } }));
    expect(() => loadConfig(p)).toThrow(/models/);
  });

  it('rejects a non-string model value', () => {
    const p = tmpFile(JSON.stringify({ models: { 'draft-impl': 4 } }));
    expect(() => loadConfig(p)).toThrow(/draft-impl/);
  });

  it('parses a max_turns map keyed by task type', () => {
    const p = tmpFile(JSON.stringify({ max_turns: { 'fetch-docs': 4, 'draft-impl': 100 } }));
    const cfg = loadConfig(p);
    expect(cfg.max_turns?.['fetch-docs']).toBe(4);
    expect(cfg.max_turns?.['draft-impl']).toBe(100);
    expect(cfg.max_turns?.['research-dossier']).toBeUndefined();
  });

  it('rejects a fractional or non-positive max_turns value (whole turns only)', () => {
    expect(() => loadConfig(tmpFile(JSON.stringify({ max_turns: { 'fetch-docs': 8.5 } })))).toThrow(/fetch-docs/);
    expect(() => loadConfig(tmpFile(JSON.stringify({ max_turns: { 'fetch-docs': 0 } })))).toThrow(/fetch-docs/);
  });

  it('parses pacing_promote as a list of task types', () => {
    const p = tmpFile(JSON.stringify({ pacing_promote: ['draft-impl', 'research-dossier'] }));
    expect(loadConfig(p).pacing_promote).toEqual(['draft-impl', 'research-dossier']);
  });

  it('rejects an unknown task type in pacing_promote', () => {
    const p = tmpFile(JSON.stringify({ pacing_promote: ['everything'] }));
    expect(() => loadConfig(p)).toThrow(/pacing_promote/);
  });
});

describe('setProjectPriority', () => {
  it('round-trips a priority change on an existing project, preserving other fields', () => {
    const p = tmpFile(JSON.stringify({
      claude_bin: 'claude',
      projects: { 'C:\\Glean': { base_branch: 'main', test_command: 'npm test' } },
    }));
    const r = setProjectPriority(p, 'C:\\Glean', 'high');
    expect(r).toEqual({ ok: true, created: false });
    const cfg = loadConfig(p);
    expect(cfg.projects?.['C:\\Glean']).toEqual({ base_branch: 'main', test_command: 'npm test', priority: 'high' });
    expect(cfg.claude_bin).toBe('claude');
  });

  it('opt-in: adds the project entry when missing', () => {
    const p = tmpFile(JSON.stringify({ projects: { 'C:\\Other': { base_branch: 'main' } } }));
    const r = setProjectPriority(p, 'C:\\New', 'normal');
    expect(r).toEqual({ ok: true, created: true });
    const cfg = loadConfig(p);
    expect(cfg.projects?.['C:\\New']?.priority).toBe('normal');
    expect(cfg.projects?.['C:\\Other']?.base_branch).toBe('main'); // untouched
  });

  it("'off' KEEPS the config entry (base_branch survives)", () => {
    const p = tmpFile(JSON.stringify({ projects: { 'C:\\Glean': { base_branch: 'main' } } }));
    const r = setProjectPriority(p, 'C:\\Glean', 'off');
    expect(r.ok).toBe(true);
    const cfg = loadConfig(p);
    expect(cfg.projects?.['C:\\Glean']).toEqual({ base_branch: 'main', priority: 'off' });
  });

  it('rejects an unknown priority value without touching the file', () => {
    const p = tmpFile(JSON.stringify({ projects: {} }));
    const before = readFileSync(p, 'utf8');
    const r = setProjectPriority(p, 'C:\\Glean', 'urgent');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/priority/);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('creates the config file when it does not exist yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glean-config-'));
    const p = join(dir, 'config.json');
    const r = setProjectPriority(p, 'C:\\Glean', 'low');
    expect(r).toEqual({ ok: true, created: true });
    expect(loadConfig(p).projects?.['C:\\Glean']?.priority).toBe('low');
  });

  it('refuses to overwrite a corrupt config file', () => {
    const p = tmpFile('{not json');
    const r = setProjectPriority(p, 'C:\\Glean', 'high');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/JSON/i);
    expect(readFileSync(p, 'utf8')).toBe('{not json');
  });
});

describe('effectivePriority', () => {
  it("returns the configured priority when set", () => {
    expect(effectivePriority({ projects: { 'C:\\A': { priority: 'high' } } }, 'C:\\A')).toBe('high');
  });
  it("defaults a configured project without priority to 'normal'", () => {
    expect(effectivePriority({ projects: { 'C:\\A': { base_branch: 'main' } } }, 'C:\\A')).toBe('normal');
  });
  it("treats an unconfigured project as 'off' (discovery never authorizes spending)", () => {
    expect(effectivePriority({ projects: {} }, 'C:\\Nope')).toBe('off');
    expect(effectivePriority({}, 'C:\\Nope')).toBe('off');
  });
});

describe('defaultConfigPath', () => {
  // Linux regression: this used a hard-coded `\` join, yielding
  // `/home/user\glean\config.json` on POSIX. Pin the platform-native join.
  it('joins home + glean + config.json with the platform separator', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    expect(defaultConfigPath()).toBe(join(home, 'glean', 'config.json'));
  });
});
