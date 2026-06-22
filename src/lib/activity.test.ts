import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  typicalFirstPromptMinutes,
  loadFirstPromptEvents,
  type FirstPromptEvent,
} from './activity.js';

// PIECE 2: morning anti-spill — the typical-first-prompt-of-day model. PURE
// function over per-session first-user-message events; null on thin data so the
// feature no-ops conservatively (never blocks the drain on a guess).

const ev = (d: Date): FirstPromptEvent => ({ ts: d });

describe('typicalFirstPromptMinutes — pure median', () => {
  it('returns the median local time-of-day (minutes past midnight) of the daily first prompt', () => {
    // Five active days, first prompts at 08:00, 09:00, 10:00, 11:00, 12:00 local.
    // One day has TWO prompts — only the EARLIEST counts for that day.
    const history: FirstPromptEvent[] = [
      ev(new Date(2026, 5, 1, 8, 0)),
      ev(new Date(2026, 5, 1, 14, 0)), // same day, later → ignored
      ev(new Date(2026, 5, 2, 9, 0)),
      ev(new Date(2026, 5, 3, 10, 0)),
      ev(new Date(2026, 5, 4, 11, 0)),
      ev(new Date(2026, 5, 5, 12, 0)),
    ];
    const now = new Date(2026, 5, 6, 12, 0);
    // medians of [480,540,600,660,720] = 600 = 10:00.
    expect(typicalFirstPromptMinutes(history, { now })).toBe(600);
  });

  it('returns null on thin data (< 5 active days)', () => {
    const history: FirstPromptEvent[] = [
      ev(new Date(2026, 5, 1, 8, 0)),
      ev(new Date(2026, 5, 2, 9, 0)),
      ev(new Date(2026, 5, 3, 10, 0)),
      ev(new Date(2026, 5, 4, 11, 0)),
    ]; // only 4 active days
    expect(typicalFirstPromptMinutes(history, { now: new Date(2026, 5, 6) })).toBeNull();
  });

  it('only counts days within the lookback window', () => {
    // 5 days inside a 14-day window + 1 ancient day that must be excluded.
    const now = new Date(2026, 5, 20, 12, 0);
    const history: FirstPromptEvent[] = [
      ev(new Date(2026, 5, 10, 7, 0)),
      ev(new Date(2026, 5, 11, 7, 0)),
      ev(new Date(2026, 5, 12, 7, 0)),
      ev(new Date(2026, 5, 13, 7, 0)),
      ev(new Date(2026, 5, 14, 7, 0)),
      ev(new Date(2026, 0, 1, 23, 0)), // way outside 14d — excluded
    ];
    expect(typicalFirstPromptMinutes(history, { now, lookbackDays: 14 })).toBe(420); // 07:00
  });

  it('with only 4 in-window days (an old day excluded) → null (thin)', () => {
    const now = new Date(2026, 5, 20, 12, 0);
    const history: FirstPromptEvent[] = [
      ev(new Date(2026, 5, 10, 7, 0)),
      ev(new Date(2026, 5, 11, 7, 0)),
      ev(new Date(2026, 5, 12, 7, 0)),
      ev(new Date(2026, 5, 13, 7, 0)),
      ev(new Date(2026, 0, 1, 23, 0)), // outside window
    ];
    expect(typicalFirstPromptMinutes(history, { now, lookbackDays: 14 })).toBeNull();
  });

  it('empty history → null', () => {
    expect(typicalFirstPromptMinutes([], { now: new Date(2026, 5, 6) })).toBeNull();
  });
});

// ── loader (I/O layer, mirrors loadDailyUsage) ──────────────────────────────

function setup(): { home: string; projectsDir: string; gleanRoot: string } {
  const home = mkdtempSync(join(tmpdir(), 'glean-activity-'));
  const projectsDir = join(home, '.claude', 'projects');
  mkdirSync(projectsDir, { recursive: true });
  const gleanRoot = join(home, 'glean');
  mkdirSync(gleanRoot, { recursive: true });
  return { home, projectsDir, gleanRoot };
}

function userLine(ts: Date, cwd?: string): string {
  const o: Record<string, unknown> = {
    type: 'user',
    timestamp: ts.toISOString(),
    message: { role: 'user', content: 'hello' },
  };
  if (cwd !== undefined) o.cwd = cwd;
  return JSON.stringify(o);
}

function assistantLine(ts: Date, cwd?: string): string {
  const o: Record<string, unknown> = {
    type: 'assistant',
    timestamp: ts.toISOString(),
    message: { role: 'assistant', content: 'hi' },
  };
  if (cwd !== undefined) o.cwd = cwd;
  return JSON.stringify(o);
}

function writeSession(projectsDir: string, slug: string, name: string, lines: string[]): void {
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join('\n') + '\n');
}

const REPO = 'C:\\fake\\repo';

describe('loadFirstPromptEvents', () => {
  it('captures the FIRST user message timestamp per session', () => {
    const { projectsDir, gleanRoot } = setup();
    const t1 = new Date(2026, 5, 8, 9, 30);
    const t2 = new Date(2026, 5, 8, 14, 0);
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [
      assistantLine(new Date(2026, 5, 8, 9, 0), REPO), // not a user message
      userLine(t1, REPO),
      userLine(t2, REPO),
    ]);
    const events = loadFirstPromptEvents(projectsDir, { gleanRoot });
    expect(events).toHaveLength(1);
    expect(events[0].ts.getTime()).toBe(t1.getTime());
  });

  it("EXCLUDES glean's own spawned sessions (cwd under the glean root)", () => {
    const { projectsDir, gleanRoot } = setup();
    // A session whose cwd is under the glean root → noise → excluded.
    writeSession(projectsDir, 'glean-own', 'g.jsonl', [
      userLine(new Date(2026, 5, 8, 3, 0), join(gleanRoot, 'work', 'wt')),
    ]);
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [
      userLine(new Date(2026, 5, 8, 9, 0), REPO),
    ]);
    const events = loadFirstPromptEvents(projectsDir, { gleanRoot });
    expect(events).toHaveLength(1);
    expect(events[0].ts.getHours()).toBe(9);
  });

  it('returns an empty list when there are no user messages', () => {
    const { projectsDir, gleanRoot } = setup();
    writeSession(projectsDir, 'C--fake-repo', 'a.jsonl', [
      assistantLine(new Date(2026, 5, 8, 9, 0), REPO),
    ]);
    expect(loadFirstPromptEvents(projectsDir, { gleanRoot })).toEqual([]);
  });
});
