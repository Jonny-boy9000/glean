import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listRuns,
  getRunDetail,
  getTaskStream,
  listDossiers,
  readDossierBody,
  discardDossier,
  retryFailed,
  getOverview,
  readCapacity,
  lastRateLimitEvent,
  scanProjectRegistry,
  isNoiseCwd,
} from './dashboard-data.js';
import { writeDrainState, type DrainState } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// A REAL captured rate_limit_event line (sanitized) from the 2026-06-11 drain run.
const CAPACITY_FIXTURE = join(
  __dirname, '..', '..', 'test', 'fixtures', 'captured-rate-limit', 'real-capacity-event.jsonl',
);

const RUN_ID = '2026-06-11-1800-d705f9';

function seedRun(root: string, runId = RUN_ID): void {
  const stateDir = join(root, 'state', runId);
  const logDir = join(root, 'logs', runId);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify({
    run_id: runId, started_at: '2026-06-11T15:00:02.519Z', ended_at: '2026-06-11T15:42:13.105Z',
    reason: 'completed', budget_ms: 3600000, elapsed_ms: 2530586, candidates_total: 2,
    ran: 1, skipped_dedup: 0, failed: 1, timed_out: 0, exit_code: 0, productive: true,
  }));

  writeFileSync(join(stateDir, 'candidates.json'), JSON.stringify({
    ranked: [
      { id: '049d2720-72ce-4b23-936f-2df3bf4dc8ec', evidence_hash: 'hashOK', type: 'research-dossier', project_path: 'C:\\Glean',
        evidence: { kind: 'todo', file: 'src/a.ts' }, est_value: 60, est_tokens: 6000, rank: 1, status: 'ok' },
      { id: '16de6dfb-7e7a-4044-bf80-eae7092f091c', evidence_hash: 'hashFAIL', type: 'research-dossier', project_path: 'C:\\Glean',
        evidence: { kind: 'todo', file: 'src/b.ts' }, est_value: 50, est_tokens: 5000, rank: 2, status: 'failed' },
    ],
    skipped_dedup: [],
  }));

  const log = [
    { t: '2026-06-11T15:00:02Z', evt: 'run.start', run_id: runId },
    { t: '2026-06-11T15:00:03Z', evt: 'task.start', task_id: '049d2720-72ce-4b23-936f-2df3bf4dc8ec', type: 'research-dossier' },
    { t: '2026-06-11T15:01:50Z', evt: 'task.end', task_id: '049d2720-72ce-4b23-936f-2df3bf4dc8ec', status: 'ok', elapsed_ms: 107000 },
    { t: '2026-06-11T15:01:51Z', evt: 'task.start', task_id: '16de6dfb-7e7a-4044-bf80-eae7092f091c', type: 'research-dossier' },
    { t: '2026-06-11T15:02:00Z', evt: 'task.end', task_id: '16de6dfb-7e7a-4044-bf80-eae7092f091c', status: 'failed', elapsed_ms: 9000 },
    { t: '2026-06-11T15:42:13Z', evt: 'run.end', reason: 'completed', ran: 1, failed: 1 },
  ].map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(logDir, 'orchestrator.log'), log + '\n');

  // a task stream for task-ok
  const stream = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done. Wrote OUT.md.' },
  ].map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(logDir, '049d2720-72ce-4b23-936f-2df3bf4dc8ec.jsonl'), stream + '\n');
}

function seedBudget(root: string, completed: string[]): void {
  const state: DrainState = {
    drain_window_id: 'w1', drain_window_started_at: '2026-06-11T15:00:02.498Z',
    next_eligible_at: null, week_exhausted: false, last_observed_weekly_reset: null,
    completed_task_ids: completed, unproductive_reentries: 0, schema: 1,
  };
  writeDrainState(root, state);
}

function seedDossier(root: string, slug: string, date: string, dir: string, opts: { out?: string } = {}): void {
  const d = join(root, 'dossiers', slug, date, dir);
  mkdirSync(d, { recursive: true });
  if (opts.out !== undefined) writeFileSync(join(d, 'OUT.md'), opts.out);
  const indexDir = join(root, 'dossiers', slug, date);
  writeFileSync(join(indexDir, 'INDEX.md'),
    `---\nproject_path: C:\\Glean\nentries:\n  - title: "Test dossier"\n    status: ok\n    type: research-dossier\n    output: "${join(d, 'OUT.md').replace(/\\/g, '\\\\')}"\n---\n# body\n`);
}

describe('listRuns / getRunDetail', () => {
  it('lists runs from summary.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-runs-'));
    seedRun(root);
    const runs = listRuns(root);
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe(RUN_ID);
    expect(runs[0].failed).toBe(1);
    expect(runs[0].in_progress).toBe(false);
  });

  it('builds task list with status and identifies failed tasks', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-detail-'));
    seedRun(root);
    const detail = getRunDetail(root, RUN_ID);
    expect(detail).not.toBeNull();
    expect(detail!.tasks).toHaveLength(2);
    const ok = detail!.tasks.find((t) => t.task_id === '049d2720-72ce-4b23-936f-2df3bf4dc8ec')!;
    expect(ok.status).toBe('ok');
    expect(ok.title).toBe('Handle TODO in src/a.ts');
    expect(ok.has_stream).toBe(true);
    expect(detail!.failed_task_ids).toEqual(['16de6dfb-7e7a-4044-bf80-eae7092f091c']);
  });

  it('rejects a malformed run id (path-traversal guard)', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-bad-'));
    expect(getRunDetail(root, '../../etc')).toBeNull();
  });
});

describe('getTaskStream', () => {
  it('returns tail and final result text', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-stream-'));
    seedRun(root);
    const s = getTaskStream(root, RUN_ID, '049d2720-72ce-4b23-936f-2df3bf4dc8ec');
    expect(s.found).toBe(true);
    expect(s.result_text).toBe('Done. Wrote OUT.md.');
    expect(s.lines.length).toBeGreaterThan(0);
  });
  it('404s for unknown task', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-stream2-'));
    seedRun(root);
    expect(getTaskStream(root, RUN_ID, 'nope').found).toBe(false);
  });
});

describe('retryFailed', () => {
  it('removes failed task evidence hashes from completed_task_ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-retry-'));
    seedRun(root);
    seedBudget(root, ['hashOK', 'hashFAIL']);
    const r = retryFailed(root, RUN_ID);
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(1);
    const overview = getOverview(root);
    expect(overview.drain.completed_count).toBe(1); // hashOK kept, hashFAIL removed
  });
});

describe('dossiers', () => {
  it('lists dossiers and flags empty shells', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-dos-'));
    seedDossier(root, 'glean', '2026-06-11', 'research-a', { out: '# Found\n\nsome **bold** text' });
    seedDossier(root, 'glean', '2026-06-11', 'research-empty'); // no OUT.md
    const list = listDossiers(root);
    expect(list.length).toBe(2);
    const empty = list.find((d) => d.dir === 'research-empty')!;
    expect(empty.has_output).toBe(false);
  });

  it('reads dossier body and discards within gleanRoot only', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-dos2-'));
    seedDossier(root, 'glean', '2026-06-11', 'research-a', { out: '# Title\n\nbody' });
    const body = readDossierBody(root, 'glean/2026-06-11/research-a');
    expect(body.found).toBe(true);
    expect(body.markdown).toContain('# Title');

    // traversal id rejected
    expect(discardDossier(root, '../../../etc').ok).toBe(false);

    const del = discardDossier(root, 'glean/2026-06-11/research-a');
    expect(del.ok).toBe(true);
    expect(existsSync(join(root, 'dossiers', 'glean', '2026-06-11', 'research-a'))).toBe(false);
  });
});

describe('readCapacity (rate_limit_event telemetry)', () => {
  const realLine = readFileSync(CAPACITY_FIXTURE, 'utf8').trim();

  it('finds the LAST rate_limit_event in the most recent run (real captured shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-cap-'));
    seedRun(root);
    // Append an earlier (lower-utilization) event then the real fixture line:
    // the LAST one must win.
    const earlier = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: 1781190000, rateLimitType: 'five_hour', utilization: 0.5, isUsingOverage: false },
    });
    writeFileSync(
      join(root, 'logs', RUN_ID, '049d2720-72ce-4b23-936f-2df3bf4dc8ec.jsonl'),
      earlier + '\n' + realLine + '\n',
      { flag: 'a' },
    );
    const cap = readCapacity(root);
    expect(cap.found).toBe(true);
    expect(cap.run_id).toBe(RUN_ID);
    expect(cap.task_id).toBe('049d2720-72ce-4b23-936f-2df3bf4dc8ec');
    expect(cap.status).toBe('allowed_warning');
    expect(cap.rate_limit_type).toBe('five_hour');
    expect(cap.utilization).toBe(0.95);
    expect(cap.resets_at).toBe(new Date(1781197200 * 1000).toISOString());
    expect(cap.is_using_overage).toBe(false);
    expect(cap.captured_at).not.toBeNull();
  });

  it('returns an honest empty state when no stream carries telemetry', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-cap2-'));
    seedRun(root); // the seeded stream has no rate_limit_event
    const cap = readCapacity(root);
    expect(cap.found).toBe(false);
    expect(cap.utilization).toBeNull();
  });

  it('returns empty for a root with no runs at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-cap3-'));
    expect(readCapacity(root).found).toBe(false);
  });

  it('skips malformed lines and tolerates absent fields', () => {
    const text = [
      '{"type":"rate_limit_event"', // truncated JSON — must not throw
      '{"type":"rate_limit_event","rate_limit_info":null}', // null info — skipped
      '{"type":"other","rate_limit_info":{"utilization":0.1}}', // wrong type — skipped
      // valid but missing utilization + resetsAt (real "allowed" events lack utilization)
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}',
    ].join('\n');
    const f = lastRateLimitEvent(text);
    expect(f).not.toBeNull();
    expect(f!.status).toBe('allowed');
    expect(f!.rate_limit_type).toBe('five_hour');
    expect(f!.utilization).toBeNull();
    expect(f!.resets_at).toBeNull();
  });

  it('returns null when the stream has no rate_limit_event lines', () => {
    expect(lastRateLimitEvent('{"type":"assistant"}\n')).toBeNull();
    expect(lastRateLimitEvent('')).toBeNull();
  });

  it('is folded into getOverview as capacity', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-cap4-'));
    seedRun(root);
    writeFileSync(join(root, 'logs', RUN_ID, '049d2720-72ce-4b23-936f-2df3bf4dc8ec.jsonl'), realLine + '\n', { flag: 'a' });
    const o = getOverview(root);
    expect(o.capacity.found).toBe(true);
    expect(o.capacity.utilization).toBe(0.95);
  });
});

describe('getOverview health flags', () => {
  it('flags a STOP sentinel and failed-tasks', () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-dash-health-'));
    seedRun(root);
    seedBudget(root, ['hashOK', 'hashFAIL']);
    writeFileSync(join(root, 'STOP'), new Date().toISOString());
    const o = getOverview(root);
    expect(o.stop_set).toBe(true);
    expect(o.state).toBe('stopped');
    expect(o.health.some((h) => h.code === 'stop-set')).toBe(true);
    expect(o.health.some((h) => h.code === 'failed-tasks')).toBe(true);
  });
});

// ---- v0.9 project portfolio: registry scanner ------------------------------
//
// The fixture mirrors the noise verified present on the dev machine:
// glean's own spawned dossier sessions (cwd under ~/glean/), agent worktrees
// (cwd under .claude\worktrees\), and temp-dir sessions. The dir-name slug is
// NEVER decoded (proven ambiguous: C--ClaudeCode-Work == C:\ClaudeCode_Work) —
// the real path comes from the "cwd" field inside the session jsonl.

describe('scanProjectRegistry', () => {
  function jsonlLine(obj: Record<string, unknown>): string {
    return JSON.stringify(obj) + '\n';
  }

  function buildFixture() {
    const home = mkdtempSync(join(tmpdir(), 'glean-registry-'));
    const gleanRoot = join(home, 'glean');
    const projectsDir = join(home, '.claude', 'projects');
    const fakeTemp = join(home, 'faketemp');
    mkdirSync(gleanRoot, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(fakeTemp, { recursive: true });

    // Real project A: exists, is a git repo, configured priority=high.
    const projA = join(home, 'repos', 'projA');
    mkdirSync(join(projA, '.git'), { recursive: true });
    // Real project B: exists, NOT git, unconfigured.
    const projB = join(home, 'repos', 'projB');
    mkdirSync(projB, { recursive: true });
    // Configured-but-historyless docs folder (e.g. Claude Desktop docs dir).
    const docsDir = join(home, 'docs');
    mkdirSync(docsDir, { recursive: true });

    const mkHistory = (slug: string, files: Array<{ name: string; lines: string; mtime?: Date }>) => {
      const dir = join(projectsDir, slug);
      mkdirSync(dir, { recursive: true });
      for (const f of files) {
        const p = join(dir, f.name);
        writeFileSync(p, f.lines);
        if (f.mtime) utimesSync(p, f.mtime, f.mtime);
      }
    };

    // projA history: two session files; cwd present in the newest.
    mkHistory('C--repos-projA', [
      { name: 's1.jsonl', lines: jsonlLine({ type: 'summary' }) + jsonlLine({ type: 'user', cwd: projA }) },
      { name: 's2.jsonl', lines: jsonlLine({ type: 'user', cwd: projA }) },
    ]);
    // A SECOND history dir resolving to the same projA cwd (dedupe case).
    mkHistory('C--repos-projA-dup', [
      { name: 's3.jsonl', lines: jsonlLine({ type: 'user', cwd: projA }) },
    ]);
    // projB history: newest file has NO cwd anywhere; older file carries it.
    const old = new Date(Date.now() - 3_600_000);
    mkHistory('C--repos-projB', [
      { name: 'new.jsonl', lines: jsonlLine({ type: 'summary' }) + jsonlLine({ type: 'noise' }) },
      { name: 'old.jsonl', lines: jsonlLine({ type: 'user', cwd: projB }), mtime: old },
    ]);
    // Noise 1: glean's own spawned dossier session (cwd under gleanRoot).
    mkHistory('C--glean-spawn', [
      { name: 'g.jsonl', lines: jsonlLine({ type: 'user', cwd: join(gleanRoot, 'dossiers', 'projA', '2026-06-12', 'x') }) },
    ]);
    // Noise 2: agent worktree session.
    mkHistory('C--worktree', [
      { name: 'w.jsonl', lines: jsonlLine({ type: 'user', cwd: join(home, 'repos', 'projA', '.claude', 'worktrees', 'agent-abc123') }) },
    ]);
    // Noise 3: temp-dir session.
    mkHistory('C--temp', [
      { name: 't.jsonl', lines: jsonlLine({ type: 'user', cwd: join(fakeTemp, 'scratch-1') }) },
    ]);
    // A history dir with no usable cwd at all (skipped entirely).
    mkHistory('C--no-cwd', [
      { name: 'n.jsonl', lines: jsonlLine({ type: 'summary' }) },
    ]);

    const configPath = join(home, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      projects: {
        [projA]: { base_branch: 'main', priority: 'high' },
        [docsDir]: {},
        [join(home, 'gone')]: { base_branch: 'main' }, // configured but deleted on disk
      },
    }));

    return { home, gleanRoot, projectsDir, fakeTemp, projA, projB, docsDir, configPath };
  }

  it('extracts real paths from jsonl cwd, filters noise, dedupes, unions config', () => {
    const f = buildFixture();
    const entries = scanProjectRegistry(f.gleanRoot, f.projectsDir, f.configPath, { tempDirs: [f.fakeTemp] });
    const byPath = new Map(entries.map((e) => [e.path, e]));

    // projA: configured, git, deduped across two history dirs (2 + 1 sessions).
    const a = byPath.get(f.projA);
    expect(a).toBeDefined();
    expect(a).toMatchObject({ exists: true, is_git: true, sessions: 3, configured: true, priority: 'high' });
    expect(typeof a?.last_activity).toBe('string');

    // projB: cwd only present in the OLDER file — still found; unconfigured ⇒ off.
    const b = byPath.get(f.projB);
    expect(b).toMatchObject({ exists: true, is_git: false, sessions: 2, configured: false, priority: 'off' });

    // Configured-but-historyless docs folder still appears.
    const d = byPath.get(f.docsDir);
    expect(d).toMatchObject({ exists: true, is_git: false, sessions: 0, last_activity: null, configured: true, priority: 'normal' });

    // Configured project deleted on disk: exists=false.
    const gone = byPath.get(join(f.home, 'gone'));
    expect(gone).toMatchObject({ exists: false, configured: true, priority: 'normal' });

    // Noise never appears: nothing under gleanRoot, worktrees, or temp.
    for (const e of entries) {
      expect(e.path.includes('dossiers')).toBe(false);
      expect(e.path.includes('worktrees')).toBe(false);
      expect(e.path.startsWith(f.fakeTemp)).toBe(false);
    }
    expect(entries).toHaveLength(4);
  });

  it('sorts configured-first, then last_activity (newest first)', () => {
    const f = buildFixture();
    const entries = scanProjectRegistry(f.gleanRoot, f.projectsDir, f.configPath, { tempDirs: [f.fakeTemp] });
    const firstUnconfigured = entries.findIndex((e) => !e.configured);
    // Every configured entry comes before every unconfigured one.
    expect(entries.slice(0, firstUnconfigured).every((e) => e.configured)).toBe(true);
    expect(entries.slice(firstUnconfigured).every((e) => !e.configured)).toBe(true);
    // Within configured: projA (has history) sorts before the historyless ones.
    expect(entries[0].path).toBe(f.projA);
  });

  it('returns only configured projects when the history dir is missing', () => {
    const f = buildFixture();
    const entries = scanProjectRegistry(f.gleanRoot, join(f.home, 'no-such-dir'), f.configPath);
    expect(entries.every((e) => e.configured)).toBe(true);
    expect(entries).toHaveLength(3);
  });
});

describe('isNoiseCwd', () => {
  const gleanRoot = join('C:', 'Users', 'u', 'glean');
  it('filters cwds under the glean root (glean-spawned sessions)', () => {
    expect(isNoiseCwd(join(gleanRoot, 'dossiers', 'x'), gleanRoot)).toBe(true);
    expect(isNoiseCwd(gleanRoot, gleanRoot)).toBe(true);
  });
  it('filters agent worktree cwds', () => {
    expect(isNoiseCwd(join('C:', 'Glean', '.claude', 'worktrees', 'agent-a1b2'), gleanRoot)).toBe(true);
  });
  it('filters AppData\\Local\\Temp cwds by default', () => {
    expect(isNoiseCwd('C:\\Users\\u\\AppData\\Local\\Temp\\xyz', gleanRoot)).toBe(true);
  });
  it('keeps a real project cwd', () => {
    expect(isNoiseCwd(join('C:', 'ClaudeCode_Work'), gleanRoot)).toBe(false);
    // A repo whose name merely CONTAINS "glean" is not under the glean root.
    expect(isNoiseCwd(join('C:', 'Users', 'u', 'gleanish'), gleanRoot)).toBe(false);
  });
});
