import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getOverview,
  listRuns,
  getRunDetail,
  getTaskStream,
  listDossiers,
  readDossierBody,
  discardDossier,
  retryFailed,
  configuredProjects,
} from './dashboard-data.js';
import { writeStop, clearStop } from './state.js';
import { Memory } from './memory.js';
import { enableSchedule, disableSchedule, defaultTriggerDay, DEFAULT_TIME, DEFAULT_REPEAT_MINUTES, DEFAULT_DURATION_HOURS } from './schedule.js';

export type ServeOpts = {
  root: string;
  templatesDir: string;
  cliEntry: string;
  nodePath: string;
  port?: number;
  host?: string;
};

const DEFAULT_PORT = 4317;

type Json = Record<string, unknown> | unknown[];

function sendJson(res: ServerResponse, status: number, body: Json): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Guard mutating requests against DNS-rebinding and cross-site POSTs: this
 * server can spawn processes and edit drain state, so every POST must come
 * from our own page (custom header a cross-origin form can't set) and target
 * a loopback Host. GETs are read-only and not guarded beyond loopback binding.
 */
function postGuardOk(req: IncomingMessage): boolean {
  if (req.headers['x-glean-dashboard'] !== '1') return false;
  if (!isLoopbackHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!isLoopbackHost(new URL(origin).host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // cap body size
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export function createHandler(opts: ServeOpts) {
  const { root, templatesDir, cliEntry, nodePath } = opts;
  const htmlPath = join(templatesDir, 'dashboard.html');

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // ---- static page ----
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        if (!existsSync(htmlPath)) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('dashboard.html not found at ' + htmlPath);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(htmlPath, 'utf8'));
        return;
      }

      // ---- read API (GET) ----
      if (method === 'GET' && path === '/api/overview') return sendJson(res, 200, getOverview(root));
      if (method === 'GET' && path === '/api/runs') return sendJson(res, 200, { runs: listRuns(root, 200) });
      if (method === 'GET' && path === '/api/dossiers') return sendJson(res, 200, { dossiers: listDossiers(root, 500) });

      if (method === 'GET' && path === '/api/dossier') {
        const id = url.searchParams.get('id') ?? '';
        const body = readDossierBody(root, id);
        if (!body.found) return sendJson(res, 404, { ok: false, reason: 'not found' });
        return sendJson(res, 200, body);
      }

      const runDetail = path.match(/^\/api\/runs\/([^/]+)$/);
      if (method === 'GET' && runDetail) {
        const detail = getRunDetail(root, decodeURIComponent(runDetail[1]));
        if (!detail) return sendJson(res, 404, { ok: false, reason: 'run not found' });
        return sendJson(res, 200, detail);
      }

      const taskStream = path.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskStream) {
        const s = getTaskStream(root, decodeURIComponent(taskStream[1]), decodeURIComponent(taskStream[2]));
        if (!s.found) return sendJson(res, 404, { ok: false, reason: 'stream not found' });
        return sendJson(res, 200, s);
      }

      // ---- management API (POST, guarded) ----
      if (method === 'POST') {
        if (!postGuardOk(req)) return sendJson(res, 403, { ok: false, reason: 'forbidden (loopback + dashboard header required)' });
        const body = await readBody(req);

        if (path === '/api/stop') {
          writeStop(root);
          return sendJson(res, 200, { ok: true, message: 'STOP sentinel written' });
        }
        if (path === '/api/resume') {
          clearStop(root);
          return sendJson(res, 200, { ok: true, message: 'STOP cleared — drain ticks resume' });
        }
        if (path === '/api/run') {
          return sendJson(res, 200, triggerRun(root, nodePath, cliEntry, String(body.project ?? '')));
        }
        const retry = path.match(/^\/api\/runs\/([^/]+)\/retry-failed$/);
        if (retry) {
          const r = retryFailed(root, decodeURIComponent(retry[1]));
          return sendJson(res, r.ok ? 200 : 400, { ...r, message: r.ok ? `re-queued ${r.removed} task(s)` : r.reason });
        }
        if (path === '/api/dossier/discard') {
          const r = discardDossier(root, String(body.id ?? ''));
          return sendJson(res, r.ok ? 200 : 400, { ...r, message: r.ok ? 'discarded' : r.reason });
        }
        if (path === '/api/rate') {
          return sendJson(res, 200, rateDossier(root, String(body.id ?? ''), String(body.verdict ?? '')));
        }
        if (path === '/api/schedule/enable') {
          return sendJson(res, 200, scheduleEnable(nodePath, cliEntry, String(body.project ?? '')));
        }
        if (path === '/api/schedule/disable') {
          try {
            disableSchedule();
            return sendJson(res, 200, { ok: true, message: 'schedule disabled' });
          } catch (e) {
            return sendJson(res, 400, { ok: false, reason: (e as Error).message });
          }
        }
      }

      sendJson(res, 404, { ok: false, reason: 'not found' });
    } catch (e) {
      sendJson(res, 500, { ok: false, reason: (e as Error).message });
    }
  };
}

function triggerRun(root: string, nodePath: string, cliEntry: string, project: string): Json {
  // Only allow runs against configured projects (the spawned process has full
  // drain powers; never let an arbitrary path through the web surface).
  const projects = configuredProjects();
  if (!project || !projects.includes(project)) {
    return { ok: false, reason: 'project not configured: ' + project };
  }
  const child = spawn(nodePath, [cliEntry, 'run', '--drain', '--project', project], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true, message: 'drain run started for ' + project, pid: child.pid ?? null };
}

function rateDossier(root: string, id: string, verdict: string): Json {
  if (!['kept', 'discarded', 'actioned'].includes(verdict)) {
    return { ok: false, reason: 'invalid verdict' };
  }
  // The dossier id is slug/date/dir; the memory row keys on candidate task_id,
  // which is the dir name's task uuid is NOT recoverable here, so we match by
  // the most recent ratable candidate whose dossier dir matches. Fall back to a
  // direct title match via listRecentRatableCandidates.
  const memory = new Memory(join(root, 'memory.db'));
  try {
    const dir = id.split('/').pop() ?? '';
    const rows = memory.listRecentRatableCandidates(100);
    const match = rows.find((r) => typeof r.dossier_path === 'string' && r.dossier_path.replace(/\\/g, '/').includes('/' + dir + '/'));
    if (!match) return { ok: false, reason: 'no memory.db row for this dossier (rate via CLI: glean rate)' };
    const result = memory.setUserRating(match.id, verdict as 'kept' | 'discarded' | 'actioned');
    if (!result.updated) return { ok: false, reason: 'rating not applied' };
    return { ok: true, message: `rated "${result.title}" as ${verdict}` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    memory.close();
  }
}

function scheduleEnable(nodePath: string, cliEntry: string, project: string): Json {
  const projects = configuredProjects();
  const proj = project || projects[0];
  if (!proj || !projects.includes(proj)) return { ok: false, reason: 'project not configured' };
  try {
    enableSchedule({
      nodePath,
      cliEntry,
      projectPath: proj,
      day: defaultTriggerDay(),
      time: DEFAULT_TIME,
      repeatMinutes: DEFAULT_REPEAT_MINUTES,
      durationHours: DEFAULT_DURATION_HOURS,
    });
    return { ok: true, message: 'schedule enabled for ' + proj };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export function startServer(opts: ServeOpts): Promise<{ port: number; server: Server; url: string }> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_PORT;
  const server = createServer(createHandler(opts));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ port: boundPort, server, url: `http://${host}:${boundPort}/` });
    });
  });
}
