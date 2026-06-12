import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  readDrainState,
  isStopRequested,
  drainStatePath,
  writeDrainState,
  type DrainState,
} from './state.js';
import { scheduleStatus, type ScheduleStatusResult } from './schedule.js';
import { titleFor } from './candidate-meta.js';
import { loadConfig, defaultConfigPath } from './config.js';
import type { Candidate, RunSummary } from './types.js';

// dashboard-data: pure-ish readers over ~/glean/ that power `glean serve`.
// Everything here is read-only EXCEPT retryFailed (edits budget.json) and
// discardDossier (rm a dossier dir) — both confined to gleanRoot.

const RUN_DIR_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-f]{6}$/;

export type RunListItem = {
  run_id: string;
  started_at: string | null;
  ended_at: string | null;
  reason: string | null;
  elapsed_ms: number | null;
  candidates_total: number | null;
  ran: number | null;
  failed: number | null;
  timed_out: number | null;
  productive: boolean | null;
  in_progress: boolean;
};

export type OverviewData = {
  generated_at: string;
  state: 'running' | 'stopped' | 'idle';
  running_run_id: string | null;
  stop_set: boolean;
  drain: {
    present: boolean;
    corrupt: boolean;
    window_started_at: string | null;
    window_age_hours: number | null;
    week_exhausted: boolean;
    unproductive_reentries: number;
    next_eligible_at: string | null;
    completed_count: number;
  };
  schedule: ScheduleStatusResult;
  latest_run: RunListItem | null;
  health: HealthFlag[];
  totals: { runs: number; dossiers: number };
  projects: string[];
};

/** Configured project paths (the only paths `glean serve` will trigger runs for). */
export function configuredProjects(): string[] {
  try {
    return Object.keys(loadConfig(defaultConfigPath()).projects ?? {});
  } catch {
    return [];
  }
}

export type HealthFlag = {
  level: 'warn' | 'info';
  code: string;
  message: string;
  action?: string; // a POST path the UI can offer as a one-click fix
};

export type OrchestratorEvent = Record<string, unknown> & { t?: string; evt?: string };

export type RunTask = {
  task_id: string;
  type: string | null;
  title: string | null;
  status: string | null;
  elapsed_ms: number | null;
  evidence_hash: string | null;
  has_stream: boolean;
};

export type RunDetail = {
  run_id: string;
  summary: RunSummary | null;
  events: OrchestratorEvent[];
  tasks: RunTask[];
  failed_task_ids: string[];
};

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** List all run ids (newest first) by scanning the state dir. */
export function listRunIds(root: string): string[] {
  const stateDir = join(root, 'state');
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((n) => RUN_DIR_RE.test(n))
    .sort()
    .reverse();
}

function summaryToListItem(runId: string, summary: RunSummary | null): RunListItem {
  return {
    run_id: runId,
    started_at: summary?.started_at ?? null,
    ended_at: summary?.ended_at ?? null,
    reason: summary?.reason ?? null,
    elapsed_ms: summary?.elapsed_ms ?? null,
    candidates_total: summary?.candidates_total ?? null,
    ran: summary?.ran ?? null,
    failed: summary?.failed ?? null,
    timed_out: summary?.timed_out ?? null,
    productive: summary?.productive ?? null,
    in_progress: summary === null,
  };
}

export function listRuns(root: string, limit = 100): RunListItem[] {
  return listRunIds(root)
    .slice(0, limit)
    .map((runId) => {
      const summary = readJsonSafe<RunSummary>(join(root, 'state', runId, 'summary.json'));
      return summaryToListItem(runId, summary);
    });
}

/** Parse logs/<run>/orchestrator.log into events (one JSON object per line). */
export function readOrchestratorEvents(root: string, runId: string): OrchestratorEvent[] {
  const path = join(root, 'logs', runId, 'orchestrator.log');
  if (!existsSync(path)) return [];
  const out: OrchestratorEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as OrchestratorEvent);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function readRankedCandidates(root: string, runId: string): Candidate[] {
  const cand = readJsonSafe<{ ranked?: Candidate[] }>(join(root, 'state', runId, 'candidates.json'));
  return cand?.ranked ?? [];
}

const OK_STATUSES = new Set(['ok', 'ok-fallback', 'skipped']);

export function getRunDetail(root: string, runId: string): RunDetail | null {
  if (!RUN_DIR_RE.test(runId)) return null;
  const logDir = join(root, 'logs', runId);
  const stateDir = join(root, 'state', runId);
  if (!existsSync(logDir) && !existsSync(stateDir)) return null;

  const summary = readJsonSafe<RunSummary>(join(stateDir, 'summary.json'));
  const events = readOrchestratorEvents(root, runId);
  const ranked = readRankedCandidates(root, runId);
  const byId = new Map(ranked.map((c) => [c.id, c]));

  // Build the task list from task.start/task.end events, enriched by candidate.
  const tasks = new Map<string, RunTask>();
  for (const e of events) {
    if (e.evt !== 'task.start' && e.evt !== 'task.end') continue;
    const taskId = String(e.task_id ?? '');
    if (!taskId) continue;
    const cand = byId.get(taskId);
    const existing = tasks.get(taskId) ?? {
      task_id: taskId,
      type: cand?.type ?? (typeof e.type === 'string' ? e.type : null),
      title: cand ? titleFor(cand) : null,
      status: null,
      elapsed_ms: null,
      evidence_hash: cand?.evidence_hash ?? null,
      has_stream: existsSync(join(logDir, `${taskId}.jsonl`)),
    };
    if (e.evt === 'task.end') {
      existing.status = typeof e.status === 'string' ? e.status : existing.status;
      existing.elapsed_ms = typeof e.elapsed_ms === 'number' ? e.elapsed_ms : existing.elapsed_ms;
    }
    tasks.set(taskId, existing);
  }

  const taskList = [...tasks.values()];
  const failed_task_ids = taskList
    .filter((t) => t.status !== null && !OK_STATUSES.has(t.status))
    .map((t) => t.task_id);

  return { run_id: runId, summary, events, tasks: taskList, failed_task_ids };
}

/** Read the last N events of a task's stream-json, plus its final result text. */
export function getTaskStream(
  root: string,
  runId: string,
  taskId: string,
  tail = 60,
): { found: boolean; lines: unknown[]; result_text: string | null } {
  if (!RUN_DIR_RE.test(runId) || !/^[0-9a-f-]{8,40}$/i.test(taskId)) {
    return { found: false, lines: [], result_text: null };
  }
  const path = join(root, 'logs', runId, `${taskId}.jsonl`);
  if (!existsSync(path)) return { found: false, lines: [], result_text: null };
  const all = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  let resultText: string | null = null;
  for (const line of all) {
    try {
      const obj = JSON.parse(line) as { type?: string; result?: string };
      if (obj.type === 'result' && typeof obj.result === 'string') resultText = obj.result;
    } catch {
      /* ignore */
    }
  }
  const lines = all.slice(-tail).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
  return { found: true, lines, result_text: resultText };
}

// ---- Dossiers -------------------------------------------------------------

export type DossierEntry = {
  id: string; // slug/date/dirname — used to address discard + body read
  project_slug: string;
  date: string;
  dir: string; // dossier subdir name
  title: string;
  status: string;
  type: string;
  has_output: boolean;
  bytes: number | null;
};

type IndexFrontmatter = {
  project_path?: string;
  entries?: Array<{ title?: string; status?: string; type?: string; output?: string }>;
};

function parseIndexFrontmatter(indexPath: string): IndexFrontmatter | null {
  try {
    const raw = readFileSync(indexPath, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    return parseYaml(m[1]) as IndexFrontmatter;
  } catch {
    return null;
  }
}

/** Enumerate dossier dirs across all projects/dates (newest date first). */
export function listDossiers(root: string, limit = 300): DossierEntry[] {
  const dossiersRoot = join(root, 'dossiers');
  if (!existsSync(dossiersRoot)) return [];
  const out: DossierEntry[] = [];
  for (const slug of safeReaddir(dossiersRoot)) {
    const slugDir = join(dossiersRoot, slug);
    if (!isDir(slugDir)) continue;
    for (const date of safeReaddir(slugDir).sort().reverse()) {
      const dateDir = join(slugDir, date);
      if (!isDir(dateDir)) continue;
      // Map INDEX entries (which carry title/status/type) by their output dir.
      const fm = parseIndexFrontmatter(join(dateDir, 'INDEX.md'));
      const byDir = new Map<string, { title?: string; status?: string; type?: string }>();
      for (const entry of fm?.entries ?? []) {
        if (entry.output) {
          const dir = lastPathSegmentDir(entry.output);
          if (dir) byDir.set(dir, entry);
        }
      }
      for (const dir of safeReaddir(dateDir)) {
        const sub = join(dateDir, dir);
        if (!isDir(sub)) continue;
        const outMd = join(sub, 'OUT.md');
        const hasOut = existsSync(outMd);
        const meta = byDir.get(dir);
        out.push({
          id: `${slug}/${date}/${dir}`,
          project_slug: slug,
          date,
          dir,
          title: meta?.title?.trim() || prettifyDir(dir),
          status: meta?.status ?? (hasOut ? 'ok' : 'empty'),
          type: meta?.type ?? 'research-dossier',
          has_output: hasOut,
          bytes: hasOut ? safeSize(outMd) : null,
        });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export function readDossierBody(root: string, id: string): { found: boolean; title: string; markdown: string } {
  const dir = resolveWithinGlean(root, join('dossiers', ...id.split('/')));
  if (!dir) return { found: false, title: '', markdown: '' };
  const outMd = join(dir, 'OUT.md');
  if (!existsSync(outMd)) {
    // Fall back to the seed prompt so an empty shell is still inspectable.
    const prompt = join(dir, 'prompt.md');
    if (existsSync(prompt)) {
      return { found: true, title: prettifyDir(id.split('/').pop() ?? id), markdown: `_(no OUT.md — task produced no output. Seed prompt:)_\n\n${safeRead(prompt)}` };
    }
    return { found: false, title: '', markdown: '' };
  }
  return { found: true, title: prettifyDir(id.split('/').pop() ?? id), markdown: safeRead(outMd) };
}

/** Delete a dossier directory. Confined to gleanRoot/dossiers. */
export function discardDossier(root: string, id: string): { ok: boolean; reason?: string } {
  const dir = resolveWithinGlean(root, join('dossiers', ...id.split('/')));
  if (!dir) return { ok: false, reason: 'invalid id' };
  if (!existsSync(dir)) return { ok: false, reason: 'not found' };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// ---- Overview / health ----------------------------------------------------

export function getOverview(root: string): OverviewData {
  const stopSet = isStopRequested(root);
  const lock = readLockHolder(root);
  const drainRead = readDrainState(root);
  const drain = drainRead.kind === 'ok' ? drainRead.state : null;
  const runs = listRuns(root, 100);
  const latest = runs[0] ?? null;

  let windowAgeHours: number | null = null;
  if (drain?.drain_window_started_at) {
    const ms = Date.now() - new Date(drain.drain_window_started_at).getTime();
    if (Number.isFinite(ms)) windowAgeHours = Math.round((ms / 3_600_000) * 10) / 10;
  }

  const state: OverviewData['state'] = lock ? 'running' : stopSet ? 'stopped' : 'idle';

  const health: HealthFlag[] = [];
  if (stopSet) {
    health.push({
      level: 'warn',
      code: 'stop-set',
      message: 'STOP sentinel is set — scheduled drain ticks are blocked until cleared.',
      action: '/api/resume',
    });
  }
  // Surface the "failed task marked complete" defect: if the latest run failed
  // tasks, offer a retry (those hashes are otherwise dedup-skipped forever).
  if (latest && (latest.failed ?? 0) > 0) {
    health.push({
      level: 'warn',
      code: 'failed-tasks',
      message: `Latest run had ${latest.failed} failed task(s) — they are dedup-recorded and will not retry on their own.`,
      action: `/api/runs/${latest.run_id}/retry-failed`,
    });
  }
  if (drainRead.kind === 'corrupt') {
    health.push({ level: 'warn', code: 'budget-corrupt', message: 'budget.json is unreadable (corrupt drain state).' });
  }
  if (drain && drain.unproductive_reentries >= 2) {
    health.push({
      level: 'info',
      code: 'unproductive',
      message: `${drain.unproductive_reentries} unproductive re-entries this window — the drain is finding no fresh work.`,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    state,
    running_run_id: lock?.run_id ?? null,
    stop_set: stopSet,
    drain: {
      present: drainRead.kind === 'ok',
      corrupt: drainRead.kind === 'corrupt',
      window_started_at: drain?.drain_window_started_at ?? null,
      window_age_hours: windowAgeHours,
      week_exhausted: drain?.week_exhausted ?? false,
      unproductive_reentries: drain?.unproductive_reentries ?? 0,
      next_eligible_at: drain?.next_eligible_at ?? null,
      completed_count: drain?.completed_task_ids.length ?? 0,
    },
    schedule: safeScheduleStatus(),
    latest_run: latest,
    health,
    totals: { runs: runs.length, dossiers: listDossiers(root, 1000).length },
    projects: configuredProjects(),
  };
}

/**
 * Re-queue a run's failed tasks: remove their evidence hashes from
 * budget.json.completed_task_ids so the next drain tick re-attempts them.
 * This is the fix for the 2026-06-11 "failed = completed" defect surfaced as
 * a one-click action.
 */
export function retryFailed(root: string, runId: string): { ok: boolean; removed: number; reason?: string } {
  const detail = getRunDetail(root, runId);
  if (!detail) return { ok: false, removed: 0, reason: 'run not found' };
  const ranked = readRankedCandidates(root, runId);
  const byId = new Map(ranked.map((c) => [c.id, c]));
  const hashes = new Set<string>();
  for (const taskId of detail.failed_task_ids) {
    const h = byId.get(taskId)?.evidence_hash;
    if (h) hashes.add(h);
  }
  if (hashes.size === 0) return { ok: true, removed: 0 };

  const drainRead = readDrainState(root);
  if (drainRead.kind !== 'ok') return { ok: false, removed: 0, reason: 'no drain state to edit' };
  const state: DrainState = drainRead.state;
  const before = state.completed_task_ids.length;
  state.completed_task_ids = state.completed_task_ids.filter((h) => !hashes.has(h));
  const removed = before - state.completed_task_ids.length;
  writeDrainState(root, state);
  return { ok: true, removed };
}

export function budgetPath(root: string): string {
  return drainStatePath(root);
}

// ---- small fs helpers -----------------------------------------------------

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function safeSize(p: string): number | null {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}
function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
function readLockHolder(root: string): { pid: number; run_id: string; started_at: string } | null {
  const lockPath = join(root, 'state', 'RUN.lock');
  if (!existsSync(lockPath)) return null;
  const holder = readJsonSafe<{ pid: number; run_id: string; started_at: string }>(lockPath);
  if (!holder) return null;
  // Only report "running" if the lock is recent (stale locks linger after crashes).
  const ageMs = Date.now() - new Date(holder.started_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > 20 * 60_000) return null;
  return holder;
}
function safeScheduleStatus(): ScheduleStatusResult {
  try {
    return scheduleStatus();
  } catch {
    return { found: false };
  }
}

/** Resolve a relative path under gleanRoot, rejecting traversal escapes. */
function resolveWithinGlean(root: string, relPath: string): string | null {
  const abs = resolve(root, relPath);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

// "research-handle-todo-in-src-lib-executor-ts" -> readable-ish fallback title.
function prettifyDir(dir: string): string {
  return dir.replace(/^research-/, '').replace(/-/g, ' ').trim() || dir;
}
// entry.output is an absolute path to .../<dir>/OUT.md — get <dir>.
function lastPathSegmentDir(output: string): string | null {
  const parts = output.replace(/\\/g, '/').split('/').filter(Boolean);
  // .../<dir>/OUT.md  -> second to last
  if (parts.length >= 2) return parts[parts.length - 2];
  return null;
}
