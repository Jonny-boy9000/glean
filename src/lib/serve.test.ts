import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { startServer } from './serve.js';
import { writeDrainState, type DrainState } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPACITY_FIXTURE = join(
  __dirname, '..', '..', 'test', 'fixtures', 'captured-rate-limit', 'real-capacity-event.jsonl',
);

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

function seed(root: string): void {
  const runId = '2026-06-11-1800-d705f9';
  const stateDir = join(root, 'state', runId);
  const logDir = join(root, 'logs', runId);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(stateDir, 'summary.json'), JSON.stringify({
    run_id: runId, started_at: '2026-06-11T15:00:02Z', ended_at: '2026-06-11T15:42:13Z',
    reason: 'completed', budget_ms: 3600000, elapsed_ms: 2530586, candidates_total: 1,
    ran: 1, skipped_dedup: 0, failed: 0, timed_out: 0, exit_code: 0, productive: true,
  }));
  const state: DrainState = {
    drain_window_id: 'w1', drain_window_started_at: '2026-06-11T15:00:02Z', next_eligible_at: null,
    week_exhausted: false, last_observed_weekly_reset: null, completed_task_ids: [], unproductive_reentries: 0, schema: 1,
  };
  writeDrainState(root, state);
}

async function boot(): Promise<{ root: string; url: string }> {
  const root = mkdtempSync(join(tmpdir(), 'glean-serve-'));
  seed(root);
  const templatesDir = join(root, 'templates');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, 'dashboard.html'), '<!doctype html><title>glean</title>');
  const { server, url } = await startServer({
    root, templatesDir, cliEntry: 'X:\\nope\\glean.js', nodePath: process.execPath, port: 0,
  });
  servers.push(server);
  return { root, url };
}

describe('glean serve', () => {
  it('serves the dashboard html at /', async () => {
    const { url } = await boot();
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('<title>glean</title>');
  });

  it('serves an inline SVG favicon at /favicon.svg and /favicon.ico', async () => {
    const { url } = await boot();
    for (const p of ['favicon.svg', 'favicon.ico']) {
      const r = await fetch(url + p);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('image/svg+xml');
      expect(await r.text()).toContain('<svg');
    }
  });

  it('serves overview JSON', async () => {
    const { url } = await boot();
    const r = await fetch(url + 'api/overview');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty('state');
    expect(j).toHaveProperty('drain');
    expect(j.totals.runs).toBe(1);
  });

  it('folds capacity telemetry into /api/overview (empty state when none captured)', async () => {
    const { root, url } = await boot();
    // No task stream yet → honest empty state.
    let o = await (await fetch(url + 'api/overview')).json();
    expect(o.capacity).toEqual(expect.objectContaining({ found: false, utilization: null }));
    // Drop a real captured rate_limit_event into the run's task stream.
    const line = readFileSync(CAPACITY_FIXTURE, 'utf8').trim();
    writeFileSync(
      join(root, 'logs', '2026-06-11-1800-d705f9', '049d2720-72ce-4b23-936f-2df3bf4dc8ec.jsonl'),
      line + '\n',
    );
    o = await (await fetch(url + 'api/overview')).json();
    expect(o.capacity.found).toBe(true);
    expect(o.capacity.status).toBe('allowed_warning');
    expect(o.capacity.rate_limit_type).toBe('five_hour');
    expect(o.capacity.utilization).toBe(0.95);
    expect(o.capacity.resets_at).toBe(new Date(1781197200 * 1000).toISOString());
  });

  it('lists runs and run detail', async () => {
    const { url } = await boot();
    const runs = await (await fetch(url + 'api/runs')).json();
    expect(runs.runs).toHaveLength(1);
    const detail = await (await fetch(url + 'api/runs/2026-06-11-1800-d705f9')).json();
    expect(detail.run_id).toBe('2026-06-11-1800-d705f9');
  });

  it('rejects a POST without the dashboard header (CSRF guard)', async () => {
    const { url } = await boot();
    const r = await fetch(url + 'api/stop', { method: 'POST' });
    expect(r.status).toBe(403);
  });

  it('accepts a guarded POST /api/stop then /api/resume', async () => {
    const { url } = await boot();
    const headers = { 'X-Glean-Dashboard': '1', 'content-type': 'application/json' };
    const stop = await fetch(url + 'api/stop', { method: 'POST', headers });
    expect(stop.status).toBe(200);
    let o = await (await fetch(url + 'api/overview')).json();
    expect(o.stop_set).toBe(true);
    const resume = await fetch(url + 'api/resume', { method: 'POST', headers });
    expect(resume.status).toBe(200);
    o = await (await fetch(url + 'api/overview')).json();
    expect(o.stop_set).toBe(false);
  });

  it('refuses /api/run for an unconfigured project', async () => {
    const { url } = await boot();
    const r = await fetch(url + 'api/run', {
      method: 'POST',
      headers: { 'X-Glean-Dashboard': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'C:\\not\\configured' }),
    });
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toContain('not configured');
  });
});

// ---- v0.9 project portfolio API ---------------------------------------------

const POST_HEADERS = { 'X-Glean-Dashboard': '1', 'content-type': 'application/json' };

async function bootPortfolio(): Promise<{
  home: string; url: string; configPath: string;
  repoA: string; repoOff: string; repoDiscovered: string;
}> {
  const home = mkdtempSync(join(tmpdir(), 'glean-serve-pf-'));
  const root = join(home, 'glean');
  mkdirSync(root, { recursive: true });
  const templatesDir = join(home, 'templates');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, 'dashboard.html'), '<!doctype html><title>glean</title>');

  const repoA = join(home, 'repoA');
  mkdirSync(join(repoA, '.git'), { recursive: true });
  const repoOff = join(home, 'repoOff');
  mkdirSync(repoOff, { recursive: true });
  const repoDiscovered = join(home, 'repoB');
  mkdirSync(repoDiscovered, { recursive: true });

  const claudeProjectsDir = join(home, '.claude', 'projects');
  const histDir = join(claudeProjectsDir, 'C--repoB');
  mkdirSync(histDir, { recursive: true });
  writeFileSync(join(histDir, 's1.jsonl'), JSON.stringify({ type: 'user', cwd: repoDiscovered }) + '\n');

  const configPath = join(home, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    projects: {
      [repoA]: { base_branch: 'main' },
      [repoOff]: { priority: 'off' },
    },
  }));

  const { server, url } = await startServer({
    root, templatesDir, cliEntry: 'X:\\nope\\glean.js', nodePath: process.execPath, port: 0,
    configPath, claudeProjectsDir,
    // The fixture lives under the real os temp dir; point the temp filter
    // elsewhere so the fixture's own repos are not filtered as noise.
    registryTempDirs: [join(home, 'faketemp')],
  });
  servers.push(server);
  return { home, url, configPath, repoA, repoOff, repoDiscovered };
}

describe('glean serve — project portfolio', () => {
  it('GET /api/projects lists registry entries, configured first', async () => {
    const { url, repoA, repoOff, repoDiscovered } = await bootPortfolio();
    const j = await (await fetch(url + 'api/projects')).json();
    const paths = j.projects.map((p: { path: string }) => p.path);
    expect(paths).toContain(repoA);
    expect(paths).toContain(repoOff);
    expect(paths).toContain(repoDiscovered);
    const byPath = new Map(j.projects.map((p: { path: string }) => [p.path, p]));
    expect(byPath.get(repoA)).toMatchObject({ configured: true, priority: 'normal', is_git: true });
    expect(byPath.get(repoOff)).toMatchObject({ configured: true, priority: 'off' });
    expect(byPath.get(repoDiscovered)).toMatchObject({ configured: false, priority: 'off', sessions: 1 });
    // configured entries strictly before discovered ones
    expect(paths.indexOf(repoDiscovered)).toBeGreaterThan(paths.indexOf(repoA));
    expect(paths.indexOf(repoDiscovered)).toBeGreaterThan(paths.indexOf(repoOff));
  });

  it('POST /api/projects/add opts a new absolute existing path in at normal priority', async () => {
    const { home, url } = await bootPortfolio();
    const fresh = join(home, 'freshRepo');
    mkdirSync(fresh, { recursive: true });
    const r = await fetch(url + 'api/projects/add', {
      method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ path: fresh }),
    });
    expect(r.status).toBe(200);
    const j = await (await fetch(url + 'api/projects')).json();
    const entry = j.projects.find((p: { path: string }) => p.path === fresh);
    expect(entry).toMatchObject({ configured: true, priority: 'normal' });
  });

  it('POST /api/projects/add rejects relative, nonexistent, and duplicate paths with clear reasons', async () => {
    const { home, url, repoA } = await bootPortfolio();
    const cases: Array<{ path: string; re: RegExp }> = [
      { path: 'relative/repo', re: /absolute/i },
      { path: join(home, 'no-such-dir'), re: /exist/i },
      { path: repoA, re: /already configured/i },
    ];
    for (const c of cases) {
      const r = await fetch(url + 'api/projects/add', {
        method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ path: c.path }),
      });
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.ok).toBe(false);
      expect(j.reason).toMatch(c.re);
    }
  });

  it('POST /api/projects/priority changes the dial (and opts in a discovered project)', async () => {
    const { url, repoA, repoDiscovered } = await bootPortfolio();
    let r = await fetch(url + 'api/projects/priority', {
      method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ path: repoA, priority: 'high' }),
    });
    expect(r.status).toBe(200);
    // Dial on a DISCOVERED project = the opt-in gesture; it becomes configured.
    r = await fetch(url + 'api/projects/priority', {
      method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ path: repoDiscovered, priority: 'low' }),
    });
    expect(r.status).toBe(200);
    const j = await (await fetch(url + 'api/projects')).json();
    const byPath = new Map(j.projects.map((p: { path: string }) => [p.path, p]));
    expect(byPath.get(repoA)).toMatchObject({ priority: 'high' });
    expect(byPath.get(repoDiscovered)).toMatchObject({ configured: true, priority: 'low' });
  });

  it('POST /api/projects/priority rejects a bad enum and an unknown path', async () => {
    const { home, url, repoA } = await bootPortfolio();
    let r = await fetch(url + 'api/projects/priority', {
      method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ path: repoA, priority: 'urgent' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).reason).toMatch(/priority/);
    r = await fetch(url + 'api/projects/priority', {
      method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ path: join(home, 'ghost'), priority: 'high' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).reason).toMatch(/unknown project/i);
  });

  it("/api/run refuses a priority-'off' project with a clear message", async () => {
    const { url, repoOff } = await bootPortfolio();
    const r = await fetch(url + 'api/run', {
      method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ project: repoOff }),
    });
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.reason).toMatch(/off/i);
    expect(j.reason).toMatch(/priority/i);
  });

  it('boots with the real bundled template and serves the Projects tab markup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glean-serve-html-'));
    const realTemplates = join(__dirname, '..', '..', 'templates');
    const { server, url } = await startServer({
      root, templatesDir: realTemplates, cliEntry: 'X:\\nope\\glean.js', nodePath: process.execPath, port: 0,
    });
    servers.push(server);
    const r = await fetch(url);
    expect(r.status).toBe(200);
    const html = await r.text();
    // tab + view container
    expect(html).toContain('data-tab="projects"');
    expect(html).toContain('id="view-projects"');
    // wired to the portfolio API
    expect(html).toContain('/api/projects');
    expect(html).toContain('/api/projects/add');
    expect(html).toContain('/api/projects/priority');
    // segmented priority control + add-project affordance + opt-in hint
    expect(html).toContain('data-priority');
    expect(html).toMatch(/Add project/i);
    expect(html).toMatch(/set a priority to opt in/i);
  });

  it('rejects portfolio POSTs without the dashboard header (CSRF guard)', async () => {
    const { url, repoA } = await bootPortfolio();
    for (const p of ['api/projects/add', 'api/projects/priority']) {
      const r = await fetch(url + p, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: repoA, priority: 'high' }),
      });
      expect(r.status).toBe(403);
    }
  });
});
