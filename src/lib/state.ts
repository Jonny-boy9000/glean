import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { z } from 'zod';
import type { RunSummary } from './types.js';

export type DrainState = {
  drain_window_id: string;
  drain_window_started_at: string;        // ISO UTC
  next_eligible_at: string | null;        // ISO UTC; when the session window reopens
  week_exhausted: boolean;
  last_observed_weekly_reset: string | null;
  completed_task_ids: string[];           // STABLE evidence_hashes completed this window
  unproductive_reentries: number;
  // Consecutive ambiguous (unclassifiable) rate-limit signals. Tracked separately
  // from unproductive_reentries so the one-retry grace before stopping is reliable.
  // Optional for backward-compat with budget.json written before this field.
  consecutive_ambiguous?: number;
  schema: 1;
};

// Zod schema mirroring DrainState. Validated in readDrainState so a
// structurally-valid-but-wrong-shape budget.json is treated as corrupt (not
// silently cast). Must accept every shape writeDrainState actually produces:
// consecutive_ambiguous is optional (backward-compat with pre-field files).
const DrainStateSchema = z.object({
  drain_window_id: z.string(),
  drain_window_started_at: z.string(),
  next_eligible_at: z.string().nullable(),
  week_exhausted: z.boolean(),
  last_observed_weekly_reset: z.string().nullable(),
  completed_task_ids: z.array(z.string()),
  unproductive_reentries: z.number(),
  consecutive_ambiguous: z.number().optional(),
  schema: z.literal(1),
});

/**
 * The user's home directory. Single source of truth for the USERPROFILE-then-HOME
 * precedence (Windows-first; HOME is the POSIX fallback). Import this everywhere a
 * home dir is needed so the precedence can never drift between call sites.
 */
export function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '';
}

export function gleanRoot(): string {
  return join(homeDir(), 'glean');
}

export function projectSlug(projectPath: string): string {
  return basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function ensureDefaultConfig(root: string): { created: boolean; path: string } {
  const path = join(root, 'config.json');
  if (existsSync(path)) return { created: false, path };
  mkdirSync(root, { recursive: true });
  writeFileSync(path, JSON.stringify({ claude_bin: 'claude' }, null, 2) + '\n');
  return { created: true, path };
}

export const STALE_LOCK_MS = 20 * 60_000;

type LockResult =
  | { acquired: true; recovered?: boolean }
  | { acquired: false; reason: 'busy'; holder: { pid: number; run_id: string; started_at: string } };

export function acquireLock(root: string, runId: string): LockResult {
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, 'RUN.lock');
  let recovered = false;
  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; run_id: string; started_at: string };
      const ageMs = Date.now() - new Date(existing.started_at).getTime();
      // A non-finite age means started_at is missing/unparseable → treat as
      // stale (a lock we can't date is not trustworthy), not as live.
      const isStaleByAge = !Number.isFinite(ageMs) || ageMs > STALE_LOCK_MS;
      if (!isStaleByAge && isPidAlive(existing.pid)) {
        return { acquired: false, reason: 'busy', holder: existing };
      }
      recovered = true;
    } catch {
      recovered = true; // corrupt lock — treat as stale
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, run_id: runId, started_at: new Date().toISOString() }));
  return { acquired: true, recovered };
}

export function releaseLock(root: string): void {
  const lockPath = join(root, 'state', 'RUN.lock');
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // sends signal 0 = liveness probe
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // EPERM = exists but we lack permission
  }
}

export function stopPath(root: string): string {
  return join(root, 'STOP');
}
export function isStopRequested(root: string): boolean {
  return existsSync(stopPath(root));
}
export function writeStop(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(stopPath(root), new Date().toISOString());
}
export function clearStop(root: string): void {
  try { unlinkSync(stopPath(root)); } catch { /* ignore */ }
}

export function ensureTemplatesDir(root: string, bundledDir: string): void {
  const userTemplates = join(root, 'templates');
  mkdirSync(userTemplates, { recursive: true });
  for (const f of readdirSync(bundledDir)) {
    const dst = join(userTemplates, f);
    if (!existsSync(dst)) copyFileSync(join(bundledDir, f), dst);
  }
}

export function writeSummary(root: string, runId: string, summary: RunSummary): void {
  const dir = join(root, 'state', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
}

export function writeCandidatesJson(root: string, runId: string, candidates: unknown): void {
  const dir = join(root, 'state', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(candidates, null, 2));
}

export function appendOrchestratorLog(root: string, runId: string, event: Record<string, unknown>): void {
  const dir = join(root, 'logs', runId);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n';
  writeFileSync(join(dir, 'orchestrator.log'), line, { flag: 'a' });
}

export function drainStatePath(root: string): string {
  return join(root, 'state', 'budget.json');
}

export type ReadDrainStateResult =
  | { kind: 'ok'; state: DrainState }
  | { kind: 'missing' }
  | { kind: 'corrupt' };

export function readDrainState(root: string): ReadDrainStateResult {
  const path = drainStatePath(root);
  if (!existsSync(path)) {
    return { kind: 'missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'corrupt' }; // not valid JSON
  }
  const result = DrainStateSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: 'corrupt' }; // valid JSON, wrong shape
  }
  return { kind: 'ok', state: result.data as DrainState };
}

export function atomicWriteFileSync(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (e) {
    // On a failed write/rename (e.g. disk full) don't leave an orphaned temp
    // file behind — the destination is untouched (atomicity preserved).
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function writeDrainState(root: string, state: DrainState): void {
  atomicWriteFileSync(drainStatePath(root), JSON.stringify(state, null, 2));
}
