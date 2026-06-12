import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isNoiseCwd } from './dashboard-data.js';
import type { DailyUsage, ModelFamily } from './types.js';

/**
 * v0.9 capacity governor — JSONL usage accounting.
 *
 * ASSUMPTION[ADR-0007]: this is glean's OWN minimal loader over
 * `~/.claude/projects/<X>/*.jsonl` `message.usage` blocks, NOT the
 * `ccusage/data-loader` dependency the capacity-governor design named.
 * Verified 2026-06-13: ccusage v20 (current) ships platform binaries with NO
 * JS exports; v19 dropped the `./data-loader` subpath; the last version
 * exporting it (18.0.11) is an upstream-abandoned API surface — and its daily
 * loader aggregates BEFORE glean's cwd-based own-session exclusion can apply.
 * See docs/decisions/0007-internal-usage-loader.md for what would reverse this.
 *
 * Output contract (glean's own, loader-independent): RAW daily token totals
 * per model family. Weighting/baselines/tiers live in pacing.ts (pure).
 */

/** Map a model id onto its family bucket. Unrecognized ids → 'unknown'. */
export function modelFamily(model: string | undefined): ModelFamily {
  if (typeof model !== 'string') return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return 'unknown';
}

/**
 * LOCAL calendar-day key (YYYY-MM-DD). Pacing is defined over the user's own
 * calendar days — a UTC bucketing would shift late-evening usage into the
 * wrong day (and across week boundaries) for any non-UTC user.
 */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type LoadOpts = {
  gleanRoot: string;
  /** Skip session files whose mtime predates this (perf window). */
  sinceMs?: number;
  /** Test seam for isNoiseCwd's temp-dir detection (fixtures live in temp). */
  tempDirs?: string[];
};

function emptyTokens(): Record<ModelFamily, number> {
  return { haiku: 0, sonnet: 0, opus: 0, unknown: 0 };
}

function listSessionFiles(dir: string, sinceMs: number | undefined): string[] {
  // ~/.claude/projects/<slug>/*.jsonl — one level deep, but walk recursively
  // for robustness (sorted for deterministic first-entry-wins dedup).
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

type ParsedEntry = {
  dateKey: string;
  family: ModelFamily;
  tokens: number;
  dedupKey: string | null;
};

/** Tolerant per-line parse: anything that isn't a well-formed usage entry → null. */
function parseUsageLine(trimmed: string): { entry: ParsedEntry | null; cwd: string | null } {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { entry: null, cwd: null };
  }
  if (obj === null || typeof obj !== 'object') return { entry: null, cwd: null };
  const cwd = typeof obj.cwd === 'string' && obj.cwd ? obj.cwd : null;

  const message = obj.message as Record<string, unknown> | undefined;
  if (message === null || typeof message !== 'object') return { entry: null, cwd };
  const usage = message.usage as Record<string, unknown> | undefined;
  if (usage === null || typeof usage !== 'object') return { entry: null, cwd };
  const model = typeof message.model === 'string' ? message.model : undefined;
  // ccusage-compatible: synthetic placeholder entries carry no real usage.
  if (model === '<synthetic>') return { entry: null, cwd };

  const ts = typeof obj.timestamp === 'string' ? new Date(obj.timestamp) : null;
  if (!ts || !Number.isFinite(ts.getTime())) return { entry: null, cwd };

  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const tokens =
    num(usage.input_tokens) +
    num(usage.output_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens);

  // Dedup by message.id + requestId, FIRST entry wins — only when BOTH exist
  // (matching ccusage's createUniqueHash rule; without both there is no
  // reliable identity, so the entry always counts).
  const msgId = typeof message.id === 'string' && message.id ? message.id : null;
  const reqId = typeof obj.requestId === 'string' && obj.requestId ? (obj.requestId as string) : null;
  const dedupKey = msgId && reqId ? `${msgId}:${reqId}` : null;

  return { entry: { dateKey: localDateKey(ts), family: modelFamily(model), tokens, dedupKey }, cwd };
}

/**
 * Load daily raw-token totals per model family from Claude Code session
 * history, EXCLUDING glean's own spawned sessions (a session is glean's when
 * its cwd is under the glean root, an agent worktree, or a temp dir — the
 * same noise rules as the dashboard's project registry, via isNoiseCwd).
 * Sessions with no cwd at all are INCLUDED: they cannot be proven
 * glean-spawned, and glean always sets cwd on its spawns.
 *
 * Returns days sorted ascending by date.
 */
export function loadDailyUsage(claudeProjectsDir: string, opts: LoadOpts): DailyUsage[] {
  const seen = new Set<string>();
  const byDate = new Map<string, Record<ModelFamily, number>>();

  for (const file of listSessionFiles(claudeProjectsDir, opts.sinceMs)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Single pass: collect this session's entries while watching for its cwd
    // (first parseable cwd wins — same rule as the registry scanner). The
    // exclusion decision needs the cwd, so entries are buffered per file.
    const entries: ParsedEntry[] = [];
    let sessionCwd: string | null = null;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const { entry, cwd } = parseUsageLine(trimmed);
      if (cwd && sessionCwd === null) sessionCwd = cwd;
      if (entry) entries.push(entry);
    }
    if (sessionCwd && isNoiseCwd(sessionCwd, opts.gleanRoot, opts.tempDirs)) continue;

    for (const e of entries) {
      if (e.dedupKey) {
        if (seen.has(e.dedupKey)) continue;
        seen.add(e.dedupKey);
      }
      const day = byDate.get(e.dateKey) ?? emptyTokens();
      day[e.family] += e.tokens;
      byDate.set(e.dateKey, day);
    }
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, tokens]) => ({ date, tokens }));
}
