import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
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
  scanProjectRegistry,
  defaultClaudeProjectsDir,
} from './dashboard-data.js';
import { writeStop, clearStop } from './state.js';
import { Memory } from './memory.js';
import { loadConfig, defaultConfigPath, setProjectPriority, isProjectPriority, effectivePriority } from './config.js';
import type { GleanConfig } from './types.js';
import { enableSchedule, disableSchedule, defaultTriggerDay, DEFAULT_TIME, DEFAULT_REPEAT_MINUTES, DEFAULT_DURATION_HOURS } from './schedule.js';

export type ServeOpts = {
  root: string;
  templatesDir: string;
  cliEntry: string;
  nodePath: string;
  port?: number;
  host?: string;
  // v0.9 project portfolio: injectable for tests; defaults are the real
  // ~/glean/config.json and ~/.claude/projects locations.
  configPath?: string;
  claudeProjectsDir?: string;
  registryTempDirs?: string[];
};

const DEFAULT_PORT = 4317;

// Inline SVG favicon (no asset pipeline; matches the dashboard's dark palette).
// Served at /favicon.svg (linked from the page) and /favicon.ico (the browser
// default probe) so neither 404s in the console.
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#14171c"/>' +
  '<text x="14" y="23" font-family="ui-monospace,Consolas,monospace" font-size="20" font-weight="700" text-anchor="middle" fill="#e6e9ee">g</text>' +
  '<circle cx="25" cy="21.5" r="2.5" fill="#6ee7b7"/>' +
  '</svg>';

type Json = Record<string, unknown> | unknown[];

function sendJson(res: ServerResponse, status: number, body: Json): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

// Exported for unit testing (F4): fetch() cannot forge a non-loopback Host
// header, so the DNS-rebinding guard is exercised directly.
//
// Host header forms: `host`, `host:port`, `[ipv6]`, `[ipv6]:port`. The bracketed
// IPv6 loopback `[::1]` (what browsers actually send) and the bare `::1` were
// already in the intended allow-set, but a naive split(':') broke both (it
// yielded `[` and `''` respectively) — IPv6 loopback was silently rejected.
// Strip an optional `[...]` wrapper, then drop a trailing `:port` only for the
// IPv4/hostname case (an unbracketed IPv6 literal has no host:port form).
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  const bracket = host.match(/^\[(.+?)\](?::\d+)?$/);
  if (bracket) {
    host = bracket[1]; // bracketed IPv6, e.g. [::1] or [::1]:4317 → ::1
  } else if (!host.includes('::') && host.includes(':')) {
    host = host.slice(0, host.indexOf(':')); // hostname/IPv4 host:port → host
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
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
  const configPath = opts.configPath ?? defaultConfigPath();
  const claudeProjectsDir = opts.claudeProjectsDir ?? defaultClaudeProjectsDir();
  const htmlPath = join(templatesDir, 'dashboard.html');
  const scanRegistry = () =>
    scanProjectRegistry(root, claudeProjectsDir, configPath, opts.registryTempDirs ? { tempDirs: opts.registryTempDirs } : undefined);

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

      if (method === 'GET' && (path === '/favicon.svg' || path === '/favicon.ico')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        res.end(FAVICON_SVG);
        return;
      }

      // ---- read API (GET) ----
      if (method === 'GET' && path === '/api/overview') return sendJson(res, 200, getOverview(root));
      if (method === 'GET' && path === '/api/runs') return sendJson(res, 200, { runs: listRuns(root, 200) });
      if (method === 'GET' && path === '/api/dossiers') return sendJson(res, 200, { dossiers: listDossiers(root, 500) });
      if (method === 'GET' && path === '/api/projects') return sendJson(res, 200, { projects: scanRegistry() });

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
          return sendJson(res, 200, triggerRun(nodePath, cliEntry, String(body.project ?? ''), configPath));
        }
        if (path === '/api/projects/add') {
          const r = addProject(configPath, String(body.path ?? ''));
          return sendJson(res, r.ok ? 200 : 400, r);
        }
        if (path === '/api/projects/priority') {
          const r = changePriority(configPath, String(body.path ?? ''), String(body.priority ?? ''), scanRegistry);
          return sendJson(res, r.ok ? 200 : 400, r);
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

function loadConfigSafe(configPath: string): GleanConfig {
  try {
    return loadConfig(configPath);
  } catch {
    return {};
  }
}

function triggerRun(nodePath: string, cliEntry: string, project: string, configPath: string): Json {
  // Only allow runs against configured projects (the spawned process has full
  // drain powers; never let an arbitrary path through the web surface).
  const cfg = loadConfigSafe(configPath);
  if (!project || !cfg.projects?.[project]) {
    return { ok: false, reason: 'project not configured: ' + project };
  }
  // The 'off' dial is absolute: a parked project is never drained, even by hand.
  if (effectivePriority(cfg, project) === 'off') {
    return { ok: false, reason: `project priority is 'off' for ${project} — set a priority (low/normal/high) to allow runs` };
  }
  const child = spawn(nodePath, [cliEntry, 'run', '--drain', '--project', project], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true, message: 'drain run started for ' + project, pid: child.pid ?? null };
}

/** Opt a project into glean's portfolio: absolute, existing, not yet configured. */
function addProject(configPath: string, path: string): { ok: boolean; reason?: string; message?: string } {
  if (!path || !isAbsolute(path)) return { ok: false, reason: 'path must be absolute: ' + (path || '(empty)') };
  if (!isDirectory(path)) return { ok: false, reason: 'path does not exist (or is not a directory): ' + path };
  const cfg = loadConfigSafe(configPath);
  if (cfg.projects?.[path]) return { ok: false, reason: 'already configured: ' + path };
  const r = setProjectPriority(configPath, path, 'normal');
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, message: 'added ' + path + " at priority 'normal'" };
}

/**
 * Change a project's priority dial. The path must be KNOWN — configured or
 * present in the session-history registry (dialing a discovered project is
 * the opt-in gesture; it becomes configured).
 */
function changePriority(
  configPath: string,
  path: string,
  priority: string,
  scanRegistry: () => Array<{ path: string }>,
): { ok: boolean; reason?: string; message?: string } {
  if (!isProjectPriority(priority)) {
    return { ok: false, reason: `invalid priority '${priority}' — use one of: off, low, normal, high` };
  }
  const cfg = loadConfigSafe(configPath);
  const known = Boolean(cfg.projects?.[path]) || scanRegistry().some((e) => e.path === path);
  if (!known) {
    return { ok: false, reason: 'unknown project: ' + path + ' — not configured and not in session history (use Add project)' };
  }
  const r = setProjectPriority(configPath, path, priority);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, message: `priority for ${path} set to '${priority}'` };
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
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
