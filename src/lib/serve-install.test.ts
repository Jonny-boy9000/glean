import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  serveAlive,
  formatAlreadyRunning,
  renderServeStatus,
  type ServeStatusReport,
  buildServeRegisterScript,
  buildServeStartCommand,
  buildServeUnregisterScript,
  buildServeStatusScript,
  buildServeServiceUnit,
  parseServeStatusOutput,
  parseServePortFromUnit,
  DEFAULT_SERVE_PORT,
  SERVE_TASK_NAME,
  SERVE_SYSTEMD_SERVICE,
} from './serve-install.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<Parameters<typeof buildServeRegisterScript>[0]> = {}) {
  return {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliEntry: 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@jonny-boy9000\\glean\\bin\\glean.js',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildServeRegisterScript — Glean\Serve logon task (mirror of buildRegisterScript)
// ---------------------------------------------------------------------------

describe('buildServeRegisterScript — defaults', () => {
  it('registers the Glean\\Serve task', () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain(SERVE_TASK_NAME); // 'Glean\\Serve'
    expect(script).toContain('Register-ScheduledTask');
    expect(script).toContain('-Force'); // idempotent replace
  });

  it('triggers at logon for the CURRENT user only', () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain('-AtLogOn');
    // Logon trigger scoped to the current user, and the principal runs as them.
    expect(script).toContain('[System.Security.Principal.WindowsIdentity]::GetCurrent().Name');
  });

  it(`serves on the default port ${DEFAULT_SERVE_PORT} when none is given`, () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain(`serve --port ${DEFAULT_SERVE_PORT}`);
  });

  it('respects a custom port', () => {
    const script = buildServeRegisterScript(makeOpts({ port: 8080 }));
    expect(script).toContain('serve --port 8080');
    expect(script).not.toContain(`serve --port ${DEFAULT_SERVE_PORT}`);
  });
});

describe('buildServeRegisterScript — hidden, resilient, battery-safe', () => {
  it('runs node hidden via conhost --headless (a console app at logon would otherwise flash a persistent window)', () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain('conhost.exe');
    expect(script).toContain('--headless');
  });

  it('runs node <cliEntry> serve, NOT a .cmd shim', () => {
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const cliEntry = 'C:\\myapp\\bin\\glean.js';
    const script = buildServeRegisterScript({ nodePath, cliEntry });
    expect(script).toContain(nodePath);
    expect(script).toContain('glean.js');
    expect(script).not.toContain('glean.cmd');
  });

  it('restarts on failure (RestartCount + RestartInterval)', () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain('-RestartCount 3');
    expect(script).toContain('-RestartInterval');
  });

  it('is battery-safe (start + keep running on battery)', () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain('AllowStartIfOnBatteries');
    expect(script).toContain('DontStopIfGoingOnBatteries');
  });

  it('never double-binds: MultipleInstances IgnoreNew', () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain('MultipleInstances');
    expect(script).toContain('IgnoreNew');
  });

  it('has no execution time limit (serve runs indefinitely)', () => {
    expect(buildServeRegisterScript(makeOpts())).toContain('TimeSpan]::Zero');
  });

  it('runs as a limited interactive principal (mirror of the drain task)', () => {
    const script = buildServeRegisterScript(makeOpts());
    expect(script).toContain('Interactive');
    expect(script).toContain('RunLevel Limited');
  });

  it('does NOT start the task inside the register script (start is a separate, skippable command)', () => {
    expect(buildServeRegisterScript(makeOpts())).not.toContain('Start-ScheduledTask');
  });
});

describe('buildServeRegisterScript — pure function contract', () => {
  it('returns a non-empty string and is deterministic', () => {
    const opts = makeOpts();
    const script = buildServeRegisterScript(opts);
    expect(script.length).toBeGreaterThan(100);
    expect(buildServeRegisterScript(opts)).toBe(script);
  });

  it('produces different output when the port changes', () => {
    expect(buildServeRegisterScript(makeOpts({ port: 5000 }))).not.toBe(buildServeRegisterScript(makeOpts()));
  });
});

// ---------------------------------------------------------------------------
// The v0.8.3 lesson, pinned for the Serve task too: Register accepts the
// combined 'Glean\Serve' but Get-/Start-/Unregister-ScheduledTask only match
// the split -TaskPath '\Glean\' -TaskName 'Serve' form.
// ---------------------------------------------------------------------------

describe('buildServeStartCommand — starts by split path + leaf', () => {
  it("uses -TaskPath '\\Glean\\' -TaskName 'Serve', not the combined form", () => {
    const cmd = buildServeStartCommand();
    expect(cmd).toContain("Start-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Serve'");
    expect(cmd).not.toContain("-TaskName 'Glean\\Serve'");
  });
});

describe('buildServeUnregisterScript — stops then deletes by split path + leaf', () => {
  it('stops the running dashboard before unregistering', () => {
    const script = buildServeUnregisterScript();
    const stopIdx = script.indexOf('Stop-ScheduledTask');
    const unregIdx = script.indexOf('Unregister-ScheduledTask');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(unregIdx).toBeGreaterThan(stopIdx);
  });

  it('uses the split form for both cmdlets, never the combined form', () => {
    const script = buildServeUnregisterScript();
    expect(script).toContain("Stop-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Serve'");
    expect(script).toContain("Unregister-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Serve'");
    expect(script).not.toContain("-TaskName 'Glean\\Serve'");
  });

  it('is a no-op when the task does not exist (-ErrorAction SilentlyContinue, -Confirm:$false)', () => {
    const script = buildServeUnregisterScript();
    expect(script).toContain('-Confirm:$false');
    expect(script).toContain('-ErrorAction SilentlyContinue');
  });
});

describe('buildServeStatusScript — queries by split path + leaf', () => {
  const script = buildServeStatusScript();

  it("uses Get-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Serve'", () => {
    expect(script).toContain("Get-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Serve'");
  });

  it('uses the split form for Get-ScheduledTaskInfo too', () => {
    expect(script).toContain("Get-ScheduledTaskInfo -TaskPath '\\Glean\\' -TaskName 'Serve'");
  });

  it('does NOT use the combined Glean\\Serve form that fails to match', () => {
    expect(script).not.toContain("-TaskName 'Glean\\Serve'");
  });

  it('emits NOT_FOUND when absent and FOUND|state|lastRun|<action args> when present', () => {
    expect(script).toContain('NOT_FOUND');
    expect(script).toContain('FOUND|');
    // The action arguments are echoed so the installed port can be recovered.
    expect(script).toContain('.Arguments');
  });

  it("avoids PowerShell's automatic $args variable", () => {
    expect(script).not.toMatch(/\$args\b/);
  });
});

// ---------------------------------------------------------------------------
// parseServeStatusOutput — turns the status script's line into a typed result
// ---------------------------------------------------------------------------

describe('parseServeStatusOutput', () => {
  it('parses a running task with its installed port from the action arguments', () => {
    const raw =
      'FOUND|Running|2026-06-13T08:00:01.0000000+03:00|' +
      '--headless "C:\\Program Files\\nodejs\\node.exe" "C:\\glean\\bin\\glean.js" serve --port 4317';
    const res = parseServeStatusOutput(raw);
    expect(res).toEqual({
      found: true,
      state: 'Running',
      lastRun: '2026-06-13T08:00:01.0000000+03:00',
      port: 4317,
    });
  });

  it('parses a Ready (registered but not running) task and a custom port', () => {
    const res = parseServeStatusOutput('FOUND|Ready|never|--headless "n" "c" serve --port 8080');
    expect(res).toEqual({ found: true, state: 'Ready', lastRun: 'never', port: 8080 });
  });

  it('returns port null when the action arguments are missing or unparseable', () => {
    const res = parseServeStatusOutput('FOUND|Ready|never|');
    expect(res).toEqual({ found: true, state: 'Ready', lastRun: 'never', port: null });
  });

  it('returns found:false for NOT_FOUND, empty, and garbage output', () => {
    expect(parseServeStatusOutput('NOT_FOUND').found).toBe(false);
    expect(parseServeStatusOutput('').found).toBe(false);
    expect(parseServeStatusOutput('something went wrong').found).toBe(false);
  });
});

// ===========================================================================
// Linux — glean-serve.service (systemd USER service, not a timer). Pure
// builders run on every OS, mirroring the schedule.test.ts contract.
// ===========================================================================

function makeLinuxOpts(overrides: Partial<Parameters<typeof buildServeServiceUnit>[0]> = {}) {
  return {
    nodePath: '/usr/bin/node',
    cliEntry: '/home/user/.npm-global/lib/node_modules/@jonny-boy9000/glean/bin/glean.js',
    ...overrides,
  };
}

describe('buildServeServiceUnit — glean-serve.service', () => {
  it('runs node <cliEntry> serve --port <port>', () => {
    const unit = buildServeServiceUnit(makeLinuxOpts());
    expect(unit).toContain('[Service]');
    expect(unit).toContain(
      `ExecStart="/usr/bin/node" "/home/user/.npm-global/lib/node_modules/@jonny-boy9000/glean/bin/glean.js" serve --port ${DEFAULT_SERVE_PORT}`,
    );
  });

  it('respects a custom port', () => {
    expect(buildServeServiceUnit(makeLinuxOpts({ port: 8080 }))).toContain('serve --port 8080');
  });

  it('restarts on failure (the Task Scheduler RestartCount analog)', () => {
    const unit = buildServeServiceUnit(makeLinuxOpts());
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=');
  });

  it('is a long-running service installed into default.target (starts at login, not a timer)', () => {
    const unit = buildServeServiceUnit(makeLinuxOpts());
    expect(unit).not.toContain('Type=oneshot');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('quotes paths so spaces survive systemd ExecStart parsing', () => {
    const unit = buildServeServiceUnit(makeLinuxOpts({ cliEntry: '/home/user/my tools/glean.js' }));
    expect(unit).toContain('"/home/user/my tools/glean.js"');
  });

  it('has a [Unit] description and is deterministic', () => {
    const opts = makeLinuxOpts();
    expect(buildServeServiceUnit(opts)).toContain('[Unit]');
    expect(buildServeServiceUnit(opts)).toBe(buildServeServiceUnit(opts));
  });
});

describe('parseServePortFromUnit — recover the installed port from the unit file', () => {
  it('finds the port in a generated unit', () => {
    expect(parseServePortFromUnit(buildServeServiceUnit(makeLinuxOpts({ port: 9999 })))).toBe(9999);
    expect(parseServePortFromUnit(buildServeServiceUnit(makeLinuxOpts()))).toBe(DEFAULT_SERVE_PORT);
  });

  it('returns null when no serve --port is present', () => {
    expect(parseServePortFromUnit('[Service]\nExecStart=/usr/bin/true\n')).toBe(null);
    expect(parseServePortFromUnit('')).toBe(null);
  });
});

describe(`unit name is stable (${SERVE_SYSTEMD_SERVICE})`, () => {
  it('stays glean-serve.service (uninstall/status address it by name)', () => {
    expect(SERVE_SYSTEMD_SERVICE).toBe('glean-serve.service');
  });
});

// ---------------------------------------------------------------------------
// serveAlive — liveness via GET /api/overview with a short timeout
// ---------------------------------------------------------------------------

let testServers: Server[] = [];
afterEach(() => {
  for (const s of testServers) s.close();
  testServers = [];
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  testServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('serveAlive', () => {
  it('returns true when a glean dashboard answers /api/overview', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/api/overview') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ state: 'idle', drain: null, totals: { runs: 0 } }));
      } else {
        res.writeHead(404).end();
      }
    });
    expect(await serveAlive(port)).toBe(true);
  });

  it('returns false when nothing listens on the port', async () => {
    // Grab a known-free port by binding and immediately closing.
    const port = await listen(() => {});
    await new Promise<void>((r) => testServers.pop()!.close(() => r()));
    expect(await serveAlive(port)).toBe(false);
  });

  it('returns false when the port is owned by something that is NOT a glean dashboard', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>some other app</html>');
    });
    expect(await serveAlive(port)).toBe(false);
  });

  it('times out (false) when the server accepts but never responds', async () => {
    const port = await listen(() => {
      /* never respond */
    });
    expect(await serveAlive(port, 300)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatAlreadyRunning — the polite singleton message for EADDRINUSE
// ---------------------------------------------------------------------------

describe('formatAlreadyRunning', () => {
  it('points at the live URL and says the logon task owns it when installed', () => {
    const msg = formatAlreadyRunning(4317, true);
    expect(msg).toContain('already running at http://127.0.0.1:4317/');
    expect(msg).toContain('installed: yes');
    expect(msg).toContain('glean serve uninstall');
  });

  it('says installed: no for a plain foreground instance', () => {
    const msg = formatAlreadyRunning(8080, false);
    expect(msg).toContain('http://127.0.0.1:8080/');
    expect(msg).toContain('installed: no');
  });

  it('admits when the install state is unknown', () => {
    expect(formatAlreadyRunning(4317, null)).toContain('installed: unknown');
  });
});

// ---------------------------------------------------------------------------
// renderServeStatus — pure renderer for `glean serve status`
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<ServeStatusReport> = {}): ServeStatusReport {
  return {
    supported: true,
    label: 'Glean\\Serve task',
    registered: true,
    state: 'Running',
    lastRun: '2026-06-13T08:00:01.0000000+03:00',
    installedPort: 4317,
    probePort: 4317,
    running: true,
    ...overrides,
  };
}

describe('renderServeStatus', () => {
  it('reports registered + responding with the URL', () => {
    const out = renderServeStatus(makeReport());
    expect(out).toContain('Glean\\Serve task: registered (Running)');
    expect(out).toContain('last run: 2026-06-13T08:00:01.0000000+03:00');
    expect(out).toContain('port: 4317');
    expect(out).toContain('dashboard: responding at http://127.0.0.1:4317/');
  });

  it('reports registered but NOT responding (dead dashboard)', () => {
    const out = renderServeStatus(makeReport({ state: 'Ready', running: false }));
    expect(out).toContain('registered (Ready)');
    expect(out).toContain('not responding on port 4317');
  });

  it('reports not registered, with the install hint', () => {
    const out = renderServeStatus(makeReport({ registered: false, state: null, lastRun: null, installedPort: null, running: false }));
    expect(out).toContain('not registered');
    expect(out).toContain('glean serve install');
  });

  it('still shows liveness when not registered but a foreground serve is up', () => {
    const out = renderServeStatus(makeReport({ registered: false, state: null, lastRun: null, installedPort: null, running: true }));
    expect(out).toContain('not registered');
    expect(out).toContain('responding at http://127.0.0.1:4317/');
  });

  it('says so when auto-start is unsupported on this platform', () => {
    const out = renderServeStatus(makeReport({ supported: false, registered: false, state: null, lastRun: null, installedPort: null }));
    expect(out).toContain('not supported');
  });
});

// ---------------------------------------------------------------------------
// Exec wrappers — read-only live checks only (mirror of schedule.test.ts's
// winOnly/linuxOnly blocks). Installing/uninstalling a REAL task in tests is
// not ok; serveTaskStatus is a pure read of Task Scheduler / systemd state.
// ---------------------------------------------------------------------------

describe('exec wrappers (live, read-only)', () => {
  const winOnly = process.platform === 'win32' ? it : it.skip;
  const linuxOnly = process.platform === 'linux' ? it : it.skip;

  winOnly('serveTaskStatus() reads Task Scheduler without throwing and returns a typed result', async () => {
    const { serveTaskStatus } = await import('./serve-install.js');
    const res = serveTaskStatus();
    expect(typeof res.found).toBe('boolean');
    if (res.found) {
      expect(typeof res.state).toBe('string');
      expect(typeof res.lastRun).toBe('string');
    }
  });

  linuxOnly('serveTaskStatus() runs without throwing when nothing is installed', async () => {
    const { serveTaskStatus } = await import('./serve-install.js');
    expect(() => serveTaskStatus()).not.toThrow();
  });

  it('serveStatusReport() composes registration + liveness without touching anything', async () => {
    const { serveStatusReport } = await import('./serve-install.js');
    // Probe a port that was just freed — liveness must come back false, and the
    // report must carry the platform's registration answer without throwing.
    const port = await listen(() => {});
    await new Promise<void>((r) => testServers.pop()!.close(() => r()));
    const report = await serveStatusReport(port);
    expect(report.probePort).toBe(port);
    expect(report.running).toBe(false);
    expect(typeof report.registered).toBe('boolean');
    expect(typeof report.supported).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Live PowerShell validity (Windows only) — mirror of schedule.test.ts: string
// assertions cannot catch quoting errors, so parse + construct (but never
// register/start/stop) in a real PowerShell.
// ---------------------------------------------------------------------------

describe('buildServeRegisterScript — live PowerShell validity', () => {
  const winOnly = process.platform === 'win32' ? it : it.skip;

  winOnly('parses as valid PowerShell (no quoting errors), even with spaced paths', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = buildServeRegisterScript({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cliEntry: 'C:\\Program Files\\glean\\bin\\glean.js',
    });
    const probe = `$ErrorActionPreference='Stop'; [ScriptBlock]::Create(@'\n${script}\n'@) | Out-Null; Write-Output 'OK'`;
    const out = execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', probe], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(out.trim()).toBe('OK');
  });

  winOnly('constructs the action/trigger/settings/principal without error', async () => {
    const { execFileSync } = await import('node:child_process');
    const full = buildServeRegisterScript(makeOpts());
    // Everything before the registration call: pure in-memory object construction.
    const construct = full.split('Register-ScheduledTask')[0] + '\nWrite-Output "BUILT"';
    const out = execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', construct], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(out).toContain('BUILT');
  });
});
