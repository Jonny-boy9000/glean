import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { loadConfig, defaultConfigPath, effectivePriority } from './config.js';
import type { Candidate, GleanConfig, ProjectPriority, RunSummary } from './types.js';

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

/**
 * Last observed session-window telemetry, read from the structured
 * `rate_limit_event` lines `claude -p` emits into the captured task streams
 * (logs/<run>/<task>.jsonl). VERIFIED shape (see ADR-0001 + the fixture at
 * test/fixtures/captured-rate-limit/): rate_limit_info carries `status`
 * ("allowed" | "allowed_warning" | …), `rateLimitType` (e.g. "five_hour"),
 * `utilization` (a FRACTION 0..1, not a percent — and sometimes absent),
 * `resetsAt` (epoch SECONDS), `isUsingOverage`. Every field is optional here
 * because real captures have varied (e.g. no `utilization` on plain "allowed").
 */
export type CapacityInfo = {
  found: boolean;
  run_id: string | null;
  task_id: string | null;
  captured_at: string | null; // stream file mtime (the events carry no timestamp)
  status: string | null;
  rate_limit_type: string | null;
  utilization: number | null; // fraction 0..1 as captured
  resets_at: string | null; // ISO, from epoch-seconds resetsAt
  is_using_overage: boolean | null;
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
  capacity: CapacityInfo;
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

// ---- Capacity (rate_limit_event telemetry) ---------------------------------

const NO_CAPACITY: CapacityInfo = {
  found: false,
  run_id: null,
  task_id: null,
  captured_at: null,
  status: null,
  rate_limit_type: null,
  utilization: null,
  resets_at: null,
  is_using_overage: null,
};

type RateLimitFields = Pick<
  CapacityInfo,
  'status' | 'rate_limit_type' | 'utilization' | 'resets_at' | 'is_using_overage'
>;

/**
 * Scan one task stream's text for the LAST `rate_limit_event` line and return
 * its fields, or null when none. Defensive per-line: malformed/truncated JSON
 * is skipped, and every rate_limit_info field is individually optional.
 */
export function lastRateLimitEvent(jsonlText: string): RateLimitFields | null {
  let found: RateLimitFields | null = null;
  for (const line of jsonlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Cheap pre-filter so we only JSON.parse plausible event lines.
    if (!trimmed || !trimmed.includes('rate_limit_event')) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: unknown; rate_limit_info?: unknown };
      if (obj?.type !== 'rate_limit_event') continue;
      const info = obj.rate_limit_info;
      if (info === null || typeof info !== 'object') continue;
      const i = info as Record<string, unknown>;
      let resetsAt: string | null = null;
      if (typeof i.resetsAt === 'number' && Number.isFinite(i.resetsAt)) {
        const d = new Date(i.resetsAt * 1000); // epoch SECONDS (verified)
        if (Number.isFinite(d.getTime())) resetsAt = d.toISOString();
      }
      // Keep scanning so the LAST valid event wins.
      found = {
        status: typeof i.status === 'string' ? i.status : null,
        rate_limit_type: typeof i.rateLimitType === 'string' ? i.rateLimitType : null,
        utilization: typeof i.utilization === 'number' && Number.isFinite(i.utilization) ? i.utilization : null,
        resets_at: resetsAt,
        is_using_overage: typeof i.isUsingOverage === 'boolean' ? i.isUsingOverage : null,
      };
    } catch {
      /* malformed / truncated line — skip it */
    }
  }
  return found;
}

/**
 * Last observed session-window utilization: walk recent runs newest-first and
 * return the last `rate_limit_event` from the most recently written task
 * stream that has one. Honest empty state (`found: false`) when no run has
 * captured any telemetry yet.
 */
export function readCapacity(root: string, runScanLimit = 5): CapacityInfo {
  for (const runId of listRunIds(root).slice(0, runScanLimit)) {
    const logDir = join(root, 'logs', runId);
    // Newest stream first so "captured_at" really is the latest signal in the run.
    const streams = safeReaddir(logDir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ name: n, mtime: safeMtimeMs(join(logDir, n)) }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const s of streams) {
      const fields = lastRateLimitEvent(safeRead(join(logDir, s.name)));
      if (!fields) continue;
      return {
        found: true,
        run_id: runId,
        task_id: s.name.replace(/\.jsonl$/, ''),
        captured_at: s.mtime > 0 ? new Date(s.mtime).toISOString() : null,
        ...fields,
      };
    }
  }
  return NO_CAPACITY;
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
    capacity: readCapacity(root),
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

// ---- v0.9 project portfolio: registry scanner ------------------------------

/** Where Claude Code keeps per-project session history (~/.claude/projects). */
export function defaultClaudeProjectsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return join(home, '.claude', 'projects');
}

export type ProjectRegistryEntry = {
  path: string;
  exists: boolean;
  is_git: boolean;
  sessions: number;
  last_activity: string | null; // ISO mtime of the newest session jsonl
  configured: boolean;
  priority: ProjectPriority;
};

// Path-prefix comparisons are done on '/'-normalized strings, case-insensitive
// on Windows only (POSIX paths are case-sensitive).
function normPath(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
function isUnder(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p || c.startsWith(p + '/');
}

const WORKTREE_RE = /[\\/]\.claude[\\/]worktrees([\\/]|$)/i;
const APPDATA_TEMP_RE = /[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)/i;

/**
 * Noise filter for session cwds — all three kinds VERIFIED present on the dev
 * machine: glean's own spawned dossier sessions (cwd under ~/glean/), agent
 * worktree sessions (cwd under .claude\worktrees\), and temp-dir scratch
 * sessions. `tempDirs` overrides the default temp detection (os.tmpdir() +
 * the literal AppData\Local\Temp pattern) — tests need this because their
 * fixtures themselves live under the real temp dir.
 */
export function isNoiseCwd(cwd: string, gleanRoot: string, tempDirs?: string[]): boolean {
  if (WORKTREE_RE.test(cwd)) return true;
  if (isUnder(cwd, gleanRoot)) return true;
  if (tempDirs) return tempDirs.some((t) => isUnder(cwd, t));
  return isUnder(cwd, tmpdir()) || APPDATA_TEMP_RE.test(cwd);
}

/**
 * Extract the real project path from a session jsonl's "cwd" field. The
 * history DIR-NAME SLUG IS NEVER DECODED — it is ambiguous (verified on this
 * machine: slug `C--ClaudeCode-Work` actually encodes `C:\ClaudeCode_Work`).
 * Scans lines of the given file; first parseable string `cwd` wins.
 */
function cwdFromJsonl(path: string): string | null {
  for (const line of safeRead(path).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('"cwd"')) continue; // cheap pre-filter
    try {
      const obj = JSON.parse(trimmed) as { cwd?: unknown };
      if (typeof obj.cwd === 'string' && obj.cwd) return obj.cwd;
    } catch {
      /* malformed line — keep scanning */
    }
  }
  return null;
}

/**
 * The project registry: every project visible in ~/.claude/projects/* session
 * history (real path from the jsonl `cwd` field, noise filtered, deduped)
 * unioned with the configured projects from config.json. Configured projects
 * carry their dial (absent = 'normal'); merely-discovered ones are 'off'.
 * Sorted configured-first, then last_activity (newest first).
 */
export function scanProjectRegistry(
  gleanRoot: string,
  claudeProjectsDir: string,
  configPath = defaultConfigPath(),
  opts?: { tempDirs?: string[] },
): ProjectRegistryEntry[] {
  let cfg: GleanConfig = {};
  try {
    cfg = loadConfig(configPath);
  } catch {
    /* corrupt config — registry still shows discovered projects */
  }

  // Aggregate history dirs by resolved cwd (multiple dirs can map to one cwd).
  const byKey = new Map<string, { path: string; sessions: number; lastMtimeMs: number }>();
  for (const dirName of safeReaddir(claudeProjectsDir)) {
    const dir = join(claudeProjectsDir, dirName);
    if (!isDir(dir)) continue;
    const files = safeReaddir(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ path: join(dir, n), mtime: safeMtimeMs(join(dir, n)) }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) continue;
    // Newest file first; fall back to older files until a cwd is found.
    let cwd: string | null = null;
    for (const f of files) {
      cwd = cwdFromJsonl(f.path);
      if (cwd) break;
    }
    if (!cwd || isNoiseCwd(cwd, gleanRoot, opts?.tempDirs)) continue;
    const key = normPath(cwd);
    const agg = byKey.get(key) ?? { path: cwd, sessions: 0, lastMtimeMs: 0 };
    agg.sessions += files.length;
    agg.lastMtimeMs = Math.max(agg.lastMtimeMs, files[0].mtime);
    byKey.set(key, agg);
  }

  const entries: ProjectRegistryEntry[] = [];
  const seenConfigured = new Set<string>();
  // Configured projects first (their config-key spelling wins for display).
  for (const projectPath of Object.keys(cfg.projects ?? {})) {
    const key = normPath(projectPath);
    seenConfigured.add(key);
    const hist = byKey.get(key);
    entries.push(makeEntry(projectPath, hist, true, effectivePriority(cfg, projectPath)));
  }
  // Then discovered-only projects (implicitly 'off' until the user opts in).
  for (const [key, hist] of byKey) {
    if (seenConfigured.has(key)) continue;
    entries.push(makeEntry(hist.path, hist, false, 'off'));
  }

  return entries.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    const am = a.last_activity ? Date.parse(a.last_activity) : 0;
    const bm = b.last_activity ? Date.parse(b.last_activity) : 0;
    if (am !== bm) return bm - am;
    return a.path.localeCompare(b.path);
  });
}

function makeEntry(
  path: string,
  hist: { sessions: number; lastMtimeMs: number } | undefined,
  configured: boolean,
  priority: ProjectPriority,
): ProjectRegistryEntry {
  return {
    path,
    exists: isDir(path),
    is_git: existsSync(join(path, '.git')),
    sessions: hist?.sessions ?? 0,
    last_activity: hist && hist.lastMtimeMs > 0 ? new Date(hist.lastMtimeMs).toISOString() : null,
    configured,
    priority,
  };
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
function safeMtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
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
