import { describe, it, expect } from 'vitest';
import {
  buildServeRegisterScript,
  buildServeStartCommand,
  buildServeUnregisterScript,
  buildServeStatusScript,
  DEFAULT_SERVE_PORT,
  SERVE_TASK_NAME,
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
