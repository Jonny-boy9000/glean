import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

// v0.9: `glean serve install|uninstall|status` — the always-on dashboard.
//
// Registering a REAL scheduled task / systemd unit in tests is NOT ok, so the
// install/uninstall exec paths are covered by the pure-builder unit tests in
// src/lib/serve-install.test.ts (platform-gated, read-only live checks only).
// What this file exercises end-to-end through the real CLI binary:
//   - `glean serve status` (read-only on every platform)
//   - the polite singleton path: foreground `glean serve` against a port that
//     a live glean dashboard already owns
//   - argument validation

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function runCli(args: string[], timeoutMs = 30_000): ReturnType<typeof spawnSync<string>> {
  return spawnSync('node', [join(repoRoot, 'bin', 'glean.js'), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd: repoRoot,
  });
}

// Async variant for tests that hold a live in-process server: spawnSync would
// freeze the event loop, so the in-process dashboard could never answer the
// child CLI's liveness probe.
function runCliAsync(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [join(repoRoot, 'bin', 'glean.js'), ...args], { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

describe('verification 25: glean serve install/uninstall/status surface', () => {
  it('serve status reports registration + liveness and exits 0 (read-only)', () => {
    const res = runCli(['serve', 'status']);
    expect(res.status).toBe(0);
    // Machine-state independent: either answer is fine, but it must answer.
    expect(res.stdout).toMatch(/registered|not registered|not supported/);
    expect(res.stdout).toMatch(/dashboard: (responding at|not responding)/);
  });

  it('rejects an unknown serve action with exit 1', () => {
    const res = runCli(['serve', 'frobnicate']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown action');
    expect(res.stderr).toMatch(/install \| uninstall \| status/);
  });

  it('foreground serve against a port owned by a live glean dashboard says "already running" and exits 0', async () => {
    // Boot a REAL glean dashboard in-process on an ephemeral port.
    const { startServer } = await import('../../src/lib/serve.js');
    const root = mkdtempSync(join(tmpdir(), 'glean-v25-'));
    const templatesDir = join(root, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'dashboard.html'), '<!doctype html><title>glean</title>');
    const { server, port } = await startServer({
      root,
      templatesDir,
      cliEntry: join(repoRoot, 'bin', 'glean.js'),
      nodePath: process.execPath,
      port: 0,
    });
    servers.push(server);

    const res = await runCliAsync(['serve', '--port', String(port)]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`already running at http://127.0.0.1:${port}/`);
    expect(res.stdout).toContain('installed:');
  });

  it('foreground serve against a port owned by a NON-glean process still fails with exit 1', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not glean');
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    const res = await runCliAsync(['serve', '--port', String(port)]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`port ${port} is already in use`);
  });
});
