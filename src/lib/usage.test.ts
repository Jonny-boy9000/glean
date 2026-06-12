import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDailyUsage, modelFamily, localDateKey } from './usage.js';

// v0.9 capacity governor: JSONL usage accounting (internal loader — see
// ADR-0006 for why this is NOT ccusage/data-loader). Output contract: daily
// RAW token totals per model family; weighting happens in pacing.ts.

function setup(): { home: string; projectsDir: string; gleanRoot: string } {
  const home = mkdtempSync(join(tmpdir(), 'glean-usage-'));
  const projectsDir = join(home, '.claude', 'projects');
  mkdirSync(projectsDir, { recursive: true });
  const gleanRoot = join(home, 'glean');
  mkdirSync(gleanRoot, { recursive: true });
  return { home, projectsDir, gleanRoot };
}

type LineOpts = {
  ts: Date;
  model?: string;
  id?: string;
  req?: string;
  cwd?: string;
  in?: number;
  out?: number;
  cw?: number; // cache_creation_input_tokens
  cr?: number; // cache_read_input_tokens
};

function usageLine(o: LineOpts): string {
  const entry: Record<string, unknown> = {
    type: 'assistant',
    timestamp: o.ts.toISOString(),
    message: {
      id: o.id,
      model: o.model ?? 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: o.in ?? 0,
        output_tokens: o.out ?? 0,
        cache_creation_input_tokens: o.cw ?? 0,
        cache_read_input_tokens: o.cr ?? 0,
      },
    },
  };
  if (o.req !== undefined) entry.requestId = o.req;
  if (o.cwd !== undefined) entry.cwd = o.cwd;
  return JSON.stringify(entry);
}

function writeSession(projectsDir: string, slug: string, name: string, lines: string[]): string {
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

// Local-calendar-day key for a Date built from LOCAL components — must match
// the loader's day attribution (design: "weighted tokens per calendar day").
function key(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const REPO = 'C:\\fake\\repo';

describe('modelFamily', () => {
  it('maps model ids onto the four families', () => {
    expect(modelFamily('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(modelFamily('claude-opus-4-1-20250805')).toBe('opus');
    expect(modelFamily('claude-3-5-haiku-20241022')).toBe('haiku');
    expect(modelFamily('claude-shiny-new-9')).toBe('unknown');
    expect(modelFamily(undefined)).toBe('unknown');
  });
});

describe('localDateKey', () => {
  it('formats the LOCAL calendar day', () => {
    expect(localDateKey(new Date(2026, 5, 8, 1, 0))).toBe('2026-06-08');
    expect(localDateKey(new Date(2026, 5, 7, 23, 30))).toBe('2026-06-07');
  });
});

describe('loadDailyUsage', () => {
  it('sums usage blocks into per-day per-family totals (golden, hand-computed)', () => {
    const { projectsDir, gleanRoot } = setup();
    const d1 = new Date(2026, 5, 8, 10, 0); // Mon Jun 8 local
    const d2 = new Date(2026, 5, 9, 11, 0); // Tue Jun 9 local
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [
      // day 1: sonnet 100+50+10+5 = 165, opus 200+100 = 300
      usageLine({ ts: d1, cwd: REPO, id: 'm1', req: 'r1', in: 100, out: 50, cw: 10, cr: 5 }),
      usageLine({ ts: d1, cwd: REPO, id: 'm2', req: 'r2', model: 'claude-opus-4-1', in: 200, out: 100 }),
      // day 2: haiku 1000+24 = 1024
      usageLine({ ts: d2, cwd: REPO, id: 'm3', req: 'r3', model: 'claude-3-5-haiku', in: 1000, out: 24 }),
    ]);
    const days = loadDailyUsage(projectsDir, { gleanRoot });
    expect(days).toEqual([
      { date: key(2026, 6, 8), tokens: { haiku: 0, sonnet: 165, opus: 300, unknown: 0 } },
      { date: key(2026, 6, 9), tokens: { haiku: 1024, sonnet: 0, opus: 0, unknown: 0 } },
    ]);
  });

  it('dedups by message.id+requestId, first entry wins, ACROSS files', () => {
    const { projectsDir, gleanRoot } = setup();
    const d = new Date(2026, 5, 8, 10, 0);
    const dup = usageLine({ ts: d, cwd: REPO, id: 'mX', req: 'rX', in: 70, out: 30 });
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [dup, dup]); // within one file
    writeSession(projectsDir, 'C--fake-repo', 'b.jsonl', [dup]); // and across files
    const days = loadDailyUsage(projectsDir, { gleanRoot });
    expect(days).toHaveLength(1);
    expect(days[0].tokens.sonnet).toBe(100);
  });

  it('never dedups entries missing message.id or requestId', () => {
    const { projectsDir, gleanRoot } = setup();
    const d = new Date(2026, 5, 8, 10, 0);
    const noReq = usageLine({ ts: d, cwd: REPO, id: 'mY', in: 10 });
    const noId = usageLine({ ts: d, cwd: REPO, req: 'rY', in: 10 });
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [noReq, noReq, noId, noId]);
    const days = loadDailyUsage(projectsDir, { gleanRoot });
    expect(days[0].tokens.sonnet).toBe(40);
  });

  it('skips malformed lines, lines without a usage block, and synthetic models', () => {
    const { projectsDir, gleanRoot } = setup();
    const d = new Date(2026, 5, 8, 10, 0);
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [
      '{ truncated json',
      JSON.stringify({ type: 'user', timestamp: d.toISOString(), cwd: REPO, message: { role: 'user' } }),
      usageLine({ ts: d, cwd: REPO, id: 'syn', req: 'rs', model: '<synthetic>', in: 9999 }),
      usageLine({ ts: d, cwd: REPO, id: 'ok', req: 'ro', in: 42 }),
      JSON.stringify({ type: 'assistant', cwd: REPO, message: { id: 'no-ts', usage: { input_tokens: 5 } } }),
    ]);
    const days = loadDailyUsage(projectsDir, { gleanRoot });
    expect(days).toEqual([
      { date: key(2026, 6, 8), tokens: { haiku: 0, sonnet: 42, opus: 0, unknown: 0 } },
    ]);
  });

  it("excludes glean's own spawned sessions (cwd under glean root / agent worktrees)", () => {
    const { projectsDir, gleanRoot } = setup();
    const d = new Date(2026, 5, 8, 10, 0);
    writeSession(projectsDir, 'glean-dossier', 's.jsonl', [
      usageLine({ ts: d, cwd: join(gleanRoot, 'dossiers', 'proj', '2026-06-08', 'x'), id: 'g1', req: 'g1', in: 500 }),
    ]);
    writeSession(projectsDir, 'glean-work', 'w.jsonl', [
      usageLine({ ts: d, cwd: join(gleanRoot, 'work', 'proj-tidy'), id: 'g2', req: 'g2', in: 500 }),
    ]);
    writeSession(projectsDir, 'agent-wt', 'w.jsonl', [
      usageLine({ ts: d, cwd: 'C:\\Repo\\.claude\\worktrees\\agent-abc', id: 'g3', req: 'g3', in: 500 }),
    ]);
    writeSession(projectsDir, 'C--fake-repo', 'real.jsonl', [
      usageLine({ ts: d, cwd: REPO, id: 'h1', req: 'h1', in: 123 }),
    ]);
    const days = loadDailyUsage(projectsDir, { gleanRoot });
    expect(days).toEqual([
      { date: key(2026, 6, 8), tokens: { haiku: 0, sonnet: 123, opus: 0, unknown: 0 } },
    ]);
  });

  it('includes sessions with no cwd field at all (cannot be proven glean-spawned)', () => {
    const { projectsDir, gleanRoot } = setup();
    const d = new Date(2026, 5, 8, 10, 0);
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [
      usageLine({ ts: d, id: 'n1', req: 'n1', in: 11 }),
    ]);
    const days = loadDailyUsage(projectsDir, { gleanRoot });
    expect(days[0].tokens.sonnet).toBe(11);
  });

  it('attributes timestamps to the LOCAL calendar day (week-boundary / timezone edge)', () => {
    const { projectsDir, gleanRoot } = setup();
    // 00:30 and 23:30 LOCAL on Jun 8 — a UTC-day loader would misfile one of
    // these on any machine whose offset is not 00:00.
    const early = new Date(2026, 5, 8, 0, 30);
    const late = new Date(2026, 5, 8, 23, 30);
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [
      usageLine({ ts: early, cwd: REPO, id: 'e', req: 'e', in: 1 }),
      usageLine({ ts: late, cwd: REPO, id: 'l', req: 'l', in: 2 }),
    ]);
    const days = loadDailyUsage(projectsDir, { gleanRoot });
    expect(days).toEqual([
      { date: key(2026, 6, 8), tokens: { haiku: 0, sonnet: 3, opus: 0, unknown: 0 } },
    ]);
  });

  it('skips files whose mtime is older than sinceMs (perf window)', () => {
    const { projectsDir, gleanRoot } = setup();
    const d = new Date(2026, 5, 8, 10, 0);
    const oldPath = writeSession(projectsDir, 'C--fake-repo', 'old.jsonl', [
      usageLine({ ts: d, cwd: REPO, id: 'o', req: 'o', in: 500 }),
    ]);
    writeSession(projectsDir, 'C--fake-repo', 'new.jsonl', [
      usageLine({ ts: d, cwd: REPO, id: 'n', req: 'n', in: 7 }),
    ]);
    const old = new Date(2026, 0, 1);
    utimesSync(oldPath, old, old);
    const days = loadDailyUsage(projectsDir, { gleanRoot, sinceMs: new Date(2026, 4, 1).getTime() });
    expect(days).toEqual([
      { date: key(2026, 6, 8), tokens: { haiku: 0, sonnet: 7, opus: 0, unknown: 0 } },
    ]);
  });

  it('returns [] for a missing projects dir', () => {
    const { gleanRoot } = setup();
    expect(loadDailyUsage(join(gleanRoot, 'nope'), { gleanRoot })).toEqual([]);
  });
});
