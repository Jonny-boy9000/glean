import { describe, it, expect } from 'vitest';
import {
  buildRegisterScript,
  buildStatusScript,
  buildUnregisterCommand,
  defaultTriggerDay,
  DEFAULT_TIME,
  DEFAULT_REPEAT_MINUTES,
  DEFAULT_DURATION_HOURS,
  TASK_NAME,
} from './schedule.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<Parameters<typeof buildRegisterScript>[0]> = {}) {
  return {
    nodePath:    'C:\\Program Files\\nodejs\\node.exe',
    cliEntry:    'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@jonny-boy9000\\glean\\bin\\glean.js',
    projectPath: 'C:\\Glean',
    // Explicit day so buildRegisterScript tests are deterministic regardless of the
    // machine's timezone (the day default is now timezone-derived — tested separately).
    day:         'Thursday',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// defaultTriggerDay — work-week-aware default (timezone-injected, deterministic)
// ---------------------------------------------------------------------------

describe('defaultTriggerDay', () => {
  it('returns Thursday for Israel (Sun–Thu work week)', () => {
    expect(defaultTriggerDay('Asia/Jerusalem')).toBe('Thursday');
  });
  it('returns Friday for a Mon–Fri timezone', () => {
    expect(defaultTriggerDay('America/New_York')).toBe('Friday');
    expect(defaultTriggerDay('Europe/London')).toBe('Friday');
  });
  it('returns Friday for UTC / unknown zones (safe default)', () => {
    expect(defaultTriggerDay('UTC')).toBe('Friday');
    expect(defaultTriggerDay('Not/AZone')).toBe('Friday');
  });
});

// ---------------------------------------------------------------------------
// Default behaviour
// ---------------------------------------------------------------------------

describe('buildRegisterScript — defaults', () => {
  it('uses the given day + 18:00 default time', () => {
    const script = buildRegisterScript(makeOpts());
    expect(script).toContain('Thursday');
    expect(script).toContain(`"${DEFAULT_TIME}"`); // '"18:00"'
  });

  it('falls back to a timezone-derived day when none is given', () => {
    const { day, ...noDay } = makeOpts();
    void day;
    const script = buildRegisterScript(noDay);
    // The fallback is defaultTriggerDay() for the current machine — assert it is
    // one of the two valid values rather than a machine-specific one.
    expect(script).toMatch(/-DaysOfWeek (Thursday|Friday)/);
  });

  it('sets 60-minute repetition interval by default', () => {
    const script = buildRegisterScript(makeOpts());
    expect(script).toContain(`FromMinutes(${DEFAULT_REPEAT_MINUTES})`);
  });

  it('sets 60-hour repetition duration by default', () => {
    const script = buildRegisterScript(makeOpts());
    expect(script).toContain(`FromHours(${DEFAULT_DURATION_HOURS})`);
  });
});

// ---------------------------------------------------------------------------
// Required PowerShell settings
// ---------------------------------------------------------------------------

describe('buildRegisterScript — required settings', () => {
  it('sets StartWhenAvailable', () => {
    expect(buildRegisterScript(makeOpts())).toContain('StartWhenAvailable');
  });

  it('sets AllowStartIfOnBatteries', () => {
    expect(buildRegisterScript(makeOpts())).toContain('AllowStartIfOnBatteries');
  });

  it('sets DontStopIfGoingOnBatteries', () => {
    expect(buildRegisterScript(makeOpts())).toContain('DontStopIfGoingOnBatteries');
  });

  it('sets MultipleInstances IgnoreNew', () => {
    const script = buildRegisterScript(makeOpts());
    expect(script).toContain('MultipleInstances');
    expect(script).toContain('IgnoreNew');
  });

  it('disables WakeToRun', () => {
    expect(buildRegisterScript(makeOpts())).toContain('WakeToRun:$false');
  });

  it('sets Interactive logon type', () => {
    expect(buildRegisterScript(makeOpts())).toContain('Interactive');
  });

  it('sets unlimited ExecutionTimeLimit', () => {
    const script = buildRegisterScript(makeOpts());
    // TimeSpan::Zero = unlimited
    expect(script).toContain('TimeSpan]::Zero');
  });

  it('uses Register-ScheduledTask -Force for idempotency', () => {
    const script = buildRegisterScript(makeOpts());
    expect(script).toContain('Register-ScheduledTask');
    expect(script).toContain('-Force');
  });
});

// ---------------------------------------------------------------------------
// Action string — the critical "no glean.cmd shim" contract
// ---------------------------------------------------------------------------

describe('buildRegisterScript — action invocation', () => {
  it('uses node <cliEntry> as the executable, NOT a .cmd shim', () => {
    const nodePath    = 'C:\\Program Files\\nodejs\\node.exe';
    const cliEntry    = 'C:\\myapp\\bin\\glean.js';
    const projectPath = 'C:\\Projects\\myproject';

    const script = buildRegisterScript({ nodePath, cliEntry, projectPath });

    // Action Execute must be the node binary.
    expect(script).toContain(`-Execute "${nodePath}"`);

    // Argument must reference glean.js (the JS entry) directly.
    expect(script).toContain('glean.js');

    // Must NOT reference a .cmd shim.
    expect(script).not.toContain('glean.cmd');
  });

  it('includes run --drain --project "<projectPath>" in the Argument', () => {
    const projectPath = 'C:\\Projects\\myproject';
    const script = buildRegisterScript(makeOpts({ projectPath }));
    expect(script).toContain('run --drain --project');
    expect(script).toContain(projectPath);
  });

  it('task name is Glean\\Drain', () => {
    const script = buildRegisterScript(makeOpts());
    expect(script).toContain(TASK_NAME);   // 'Glean\\Drain'
  });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

describe('buildRegisterScript — overrides respected', () => {
  it('respects custom day (Wednesday)', () => {
    const script = buildRegisterScript(makeOpts({ day: 'Wednesday' }));
    expect(script).toContain('Wednesday');
    expect(script).not.toContain('Thursday');
  });

  it('respects custom time (22:30)', () => {
    const script = buildRegisterScript(makeOpts({ time: '22:30' }));
    expect(script).toContain('"22:30"');
  });

  it('respects custom repeatMinutes (30)', () => {
    const script = buildRegisterScript(makeOpts({ repeatMinutes: 30 }));
    expect(script).toContain('FromMinutes(30)');
    expect(script).not.toContain(`FromMinutes(${DEFAULT_REPEAT_MINUTES})`);
  });

  it('respects custom durationHours (8)', () => {
    const script = buildRegisterScript(makeOpts({ durationHours: 8 }));
    expect(script).toContain('FromHours(8)');
    expect(script).not.toContain(`FromHours(${DEFAULT_DURATION_HOURS})`);
  });

  it('embeds the correct node path in the action', () => {
    const nodePath = 'D:\\tools\\nodejs\\node.exe';
    const script = buildRegisterScript(makeOpts({ nodePath }));
    expect(script).toContain(nodePath);
  });

  it('embeds the correct project path in the argument', () => {
    const projectPath = 'D:\\code\\my-project';
    const script = buildRegisterScript(makeOpts({ projectPath }));
    expect(script).toContain(projectPath);
  });
});

// ---------------------------------------------------------------------------
// String generation only — no OS calls in tests
// ---------------------------------------------------------------------------

describe('buildRegisterScript — pure function contract', () => {
  it('returns a non-empty string', () => {
    const script = buildRegisterScript(makeOpts());
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(100);
  });

  it('produces deterministic output for identical inputs', () => {
    const opts = makeOpts();
    expect(buildRegisterScript(opts)).toBe(buildRegisterScript(opts));
  });

  it('produces different output when day changes', () => {
    const a = buildRegisterScript(makeOpts({ day: 'Monday' }));
    const b = buildRegisterScript(makeOpts({ day: 'Friday' }));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Live PowerShell validity (Windows only). String-presence tests cannot catch
// PowerShell quoting errors or read-only-property assignments — these two bugs
// both shipped past the toContain() checks and were only caught by actually
// parsing + constructing in PowerShell. This block runs the generated script up
// to (but NOT including) Register-ScheduledTask, so it builds the action/trigger/
// settings/principal objects (pure, in-memory) without registering anything.
// ---------------------------------------------------------------------------

describe('buildRegisterScript — live PowerShell validity', () => {
  const winOnly = process.platform === 'win32' ? it : it.skip;

  winOnly('parses as valid PowerShell (no quoting errors), even with spaced paths', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = buildRegisterScript(makeOpts({
      cliEntry: 'C:\\Program Files\\glean\\bin\\glean.js',
      projectPath: 'C:\\My Projects\\app',
    }));
    // [ScriptBlock]::Create throws on a syntax error; no execution happens.
    const probe = `$ErrorActionPreference='Stop'; [ScriptBlock]::Create(@'\n${script}\n'@) | Out-Null; Write-Output 'OK'`;
    const out = execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', probe], {
      encoding: 'utf8', windowsHide: true,
    });
    expect(out.trim()).toBe('OK');
  });

  winOnly('constructs the action/trigger/settings/principal without error', async () => {
    const { execFileSync } = await import('node:child_process');
    const full = buildRegisterScript(makeOpts({ projectPath: 'C:\\My Projects\\app' }));
    // Everything before the registration call: pure in-memory object construction.
    const construct = full.split('Register-ScheduledTask')[0] + '\nWrite-Output "BUILT"';
    const out = execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', construct], {
      encoding: 'utf8', windowsHide: true,
    });
    expect(out).toContain('BUILT');
  });
});

// ---------------------------------------------------------------------------
// Regression (found live on Windows 2026-06-02): the read/delete cmdlets must
// query the task by the split -TaskPath '\Glean\' -TaskName 'Drain' form. The
// combined 'Glean\Drain' (what Register accepts) does NOT match in
// Get-ScheduledTask / Unregister-ScheduledTask, so `glean schedule status`
// reported a registered task as "not registered". Pin the correct query shape.
// ---------------------------------------------------------------------------

describe('buildStatusScript — queries the task by split path + leaf', () => {
  const script = buildStatusScript();

  it('uses -TaskPath \\Glean\\ + -TaskName Drain for Get-ScheduledTask', () => {
    expect(script).toContain("Get-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Drain'");
  });

  it('uses the split form for Get-ScheduledTaskInfo too', () => {
    expect(script).toContain("Get-ScheduledTaskInfo -TaskPath '\\Glean\\' -TaskName 'Drain'");
  });

  it('does NOT use the combined Glean\\Drain form that fails to match', () => {
    expect(script).not.toContain("-TaskName 'Glean\\Drain'");
  });
});

describe('buildUnregisterCommand — deletes by split path + leaf', () => {
  it('uses -TaskPath \\Glean\\ + -TaskName Drain, not the combined form', () => {
    const cmd = buildUnregisterCommand();
    expect(cmd).toContain("Unregister-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Drain'");
    expect(cmd).not.toContain("-TaskName 'Glean\\Drain'");
    expect(cmd).toContain('-Confirm:$false');
  });
});
