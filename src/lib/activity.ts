import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isNoiseCwd } from './dashboard-data.js';
import { localDateKey } from './usage.js';

/**
 * PIECE 2: morning anti-spill — model the user's TYPICAL first-prompt time of
 * day so a drain can stop before fresh capacity is wanted.
 *
 * Two layers, mirroring usage.ts:
 *  - loadFirstPromptEvents() is the I/O layer: it walks
 *    `~/.claude/projects/<X>/*.jsonl`, EXCLUDES glean's own spawned sessions
 *    (cwd under the glean root / a worktree / a temp dir, via isNoiseCwd), and
 *    emits one event per session = the timestamp of its FIRST user message.
 *  - typicalFirstPromptMinutes() is PURE: median local time-of-day (minutes
 *    past local midnight) of the EARLIEST first-prompt per active day over the
 *    trailing N days. Null on thin data (< MIN_ACTIVE_DAYS) so the feature
 *    no-ops conservatively — it must NEVER block the drain on a guess.
 */

/** One session's first user message. `ts` is the local Date of that message. */
export type FirstPromptEvent = { ts: Date };

/** Minimum distinct active days required before the median is trusted. */
export const MIN_ACTIVE_DAYS = 5;

export type TypicalOpts = {
  now: Date;
  /** Trailing window (default 14 days). */
  lookbackDays?: number;
};

/** Local minutes past midnight for a Date (0..1439). */
function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** Median of a numeric list (even count → mean of the middle two). Empty → 0. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * PURE: the user's typical first-prompt time of day, in minutes past local
 * midnight, or null when there is too little data to be trustworthy.
 */
export function typicalFirstPromptMinutes(
  history: FirstPromptEvent[],
  opts: TypicalOpts,
): number | null {
  const lookbackDays = opts.lookbackDays ?? 14;
  const cutoffMs = opts.now.getTime() - lookbackDays * 86_400_000;

  // Earliest first-prompt minute-of-day per LOCAL active day, in-window only.
  const earliestPerDay = new Map<string, number>();
  for (const e of history) {
    if (e.ts.getTime() < cutoffMs || e.ts.getTime() > opts.now.getTime()) continue;
    const key = localDateKey(e.ts);
    const mins = minutesOfDay(e.ts);
    const prev = earliestPerDay.get(key);
    if (prev === undefined || mins < prev) earliestPerDay.set(key, mins);
  }

  if (earliestPerDay.size < MIN_ACTIVE_DAYS) return null;
  return median([...earliestPerDay.values()]);
}

type LoadOpts = {
  gleanRoot: string;
  /** Skip session files whose mtime predates this (perf window). */
  sinceMs?: number;
  /** Test seam for isNoiseCwd's temp-dir detection (fixtures live in temp). */
  tempDirs?: string[];
};

function listSessionFiles(dir: string, sinceMs: number | undefined): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listSessionFiles(path, sinceMs));
    } else if (name.endsWith('.jsonl')) {
      if (sinceMs !== undefined && st.mtimeMs < sinceMs) continue;
      out.push(path);
    }
  }
  return out;
}

/**
 * I/O layer: one FirstPromptEvent per session = its EARLIEST user message,
 * excluding glean's own spawned sessions (same isNoiseCwd rules as usage.ts).
 * Sessions with no cwd are INCLUDED (cannot be proven glean-spawned).
 */
export function loadFirstPromptEvents(claudeProjectsDir: string, opts: LoadOpts): FirstPromptEvent[] {
  const events: FirstPromptEvent[] = [];

  for (const file of listSessionFiles(claudeProjectsDir, opts.sinceMs)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let sessionCwd: string | null = null;
    let earliest: Date | null = null;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj === null || typeof obj !== 'object') continue;
      if (typeof obj.cwd === 'string' && obj.cwd && sessionCwd === null) sessionCwd = obj.cwd;
      if (obj.type !== 'user') continue;
      if (typeof obj.timestamp !== 'string') continue;
      const ts = new Date(obj.timestamp);
      if (!Number.isFinite(ts.getTime())) continue;
      if (earliest === null || ts.getTime() < earliest.getTime()) earliest = ts;
    }
    if (sessionCwd && isNoiseCwd(sessionCwd, opts.gleanRoot, opts.tempDirs)) continue;
    if (earliest !== null) events.push({ ts: earliest });
  }

  return events;
}
