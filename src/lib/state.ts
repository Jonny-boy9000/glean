import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { RunSummary } from './types.js';

export type DrainState = {
  drain_window_id: string;
  drain_window_started_at: string;        // ISO UTC
  next_eligible_at: string | null;        // ISO UTC; when the session window reopens
  week_exhausted: boolean;
  last_observed_weekly_reset: string | null;
  completed_task_ids: string[];
  unproductive_reentries: number;
  schema: 1;
};

export function gleanRoot(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return join(home, 'glean');
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
      const isStaleByAge = ageMs > STALE_LOCK_MS;
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
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as DrainState;
    return { kind: 'ok', state };
  } catch {
    return { kind: 'corrupt' };
  }
}

export function atomicWriteFileSync(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function writeDrainState(root: string, state: DrainState): void {
  atomicWriteFileSync(drainStatePath(root), JSON.stringify(state, null, 2));
}
