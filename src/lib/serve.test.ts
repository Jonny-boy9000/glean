import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { startServer } from './serve.js';
import { writeDrainState, type DrainState } from './state.js';

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

  it('serves overview JSON', async () => {
    const { url } = await boot();
    const r = await fetch(url + 'api/overview');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toHaveProperty('state');
    expect(j).toHaveProperty('drain');
    expect(j.totals.runs).toBe(1);
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
