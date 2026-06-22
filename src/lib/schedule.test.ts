import { describe, it, expect } from 'vitest';
import {
  buildRegisterScript,
  buildStatusScript,
  buildUnregisterCommand,
  buildSystemdUnit,
  buildTimerUnit,
  buildCrontabLine,
  mergeCrontabLines,
  stripCrontabLines,
  parseListTimers,
  defaultTriggerDay,
  DEFAULT_TIME,
  DEFAULT_REPEAT_MINUTES,
  DEFAULT_DURATION_HOURS,
  TASK_NAME,
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  CRON_MARKER,
  // PIECE 3: nightly pace-gated drain task.
  buildNightlyRegisterScript,
  buildNightlyStatusScript,
  buildNightlyUnregisterCommand,
  NIGHTLY_TASK_NAME,
  DEFAULT_NIGHTLY_TIME,
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

// ---------------------------------------------------------------------------
// F3 — PowerShell injection hardening. `day` / `time` reach the generated
// script unquoted (`-DaysOfWeek ${day}`, `-At "${time}"`) and paths were
// escaped for `"` only — not `$(...)` / backtick subexpressions. Values come
// from CLI flags / config.json (defense-in-depth, not the web surface), but a
// malicious value could inject PowerShell. Validate day/time and neutralize
// `$` + backtick in interpolated paths.
// ---------------------------------------------------------------------------

describe('buildRegisterScript — injection hardening (F3)', () => {
  it('rejects a malicious day (not a weekday name)', () => {
    expect(() => buildRegisterScript(makeOpts({ day: 'Thursday; rm -rf /' }))).toThrow(/day/i);
    expect(() => buildRegisterScript(makeOpts({ day: '$(calc.exe)' }))).toThrow(/day/i);
    expect(() => buildRegisterScript(makeOpts({ day: 'Funday' }))).toThrow(/day/i);
  });

  it('accepts every real weekday name (and defaultTriggerDay output)', () => {
    for (const d of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
      expect(() => buildRegisterScript(makeOpts({ day: d }))).not.toThrow();
    }
    // The two values defaultTriggerDay can ever produce must pass the whitelist.
    for (const tz of ['Asia/Jerusalem', 'America/New_York', 'UTC']) {
      expect(() => buildRegisterScript(makeOpts({ day: defaultTriggerDay(tz) }))).not.toThrow();
    }
  });

  it('rejects a malicious time (not HH:MM)', () => {
    expect(() => buildRegisterScript(makeOpts({ time: '18:00"; calc; "' }))).toThrow(/time/i);
    expect(() => buildRegisterScript(makeOpts({ time: '$(calc)' }))).toThrow(/time/i);
    expect(() => buildRegisterScript(makeOpts({ time: '6:00' }))).toThrow(/time/i); // needs HH
    expect(() => buildRegisterScript(makeOpts({ time: '1800' }))).toThrow(/time/i);
  });

  it('accepts a valid HH:MM time', () => {
    expect(() => buildRegisterScript(makeOpts({ time: '18:00' }))).not.toThrow();
    expect(() => buildRegisterScript(makeOpts({ time: '06:30' }))).not.toThrow();
    expect(() => buildRegisterScript(makeOpts({ time: '23:59' }))).not.toThrow();
  });

  it('neutralizes $(...) / backtick in an interpolated path (cannot execute)', () => {
    const evil = 'C:\\evil$(calc.exe)\\glean.js';
    const script = buildRegisterScript(makeOpts({ cliEntry: evil }));
    // In PowerShell, a backtick before `$` makes it a literal — so the subexpr
    // cannot run. Assert NO unescaped `$(` survives (negative lookbehind for a
    // preceding backtick), and that the escaped form `\`$( IS present.
    expect(script).not.toMatch(/(?<!`)\$\(/);
    expect(script).toContain('`$(calc.exe)');
  });

  it('neutralizes a backtick in an interpolated path (no live escape sequence)', () => {
    const script = buildRegisterScript(makeOpts({ cliEntry: 'C:\\a`b\\glean.js' }));
    // A lone path backtick is doubled to a literal backtick (``), so it can't
    // form an escape like `n / `t against the next char.
    expect(script).toContain('C:\\a``b\\glean.js');
  });
});

// ===========================================================================
// PIECE 3: nightly pace-gated drain — a SEPARATE Glean\Nightly DAILY task that
// runs `glean run --drain` every night. The drain self-gates on the pacing tier
// (pace-skip when there's no slack), so a daily fire is safe. The weekly path is
// untouched. These builders are pure strings, runnable on every OS.
// ===========================================================================

describe('buildNightlyRegisterScript — daily Glean\\Nightly task', () => {
  // Lazy import keeps these symbols out of the main import block if absent.
  function build(overrides: Partial<Parameters<typeof buildRegisterScript>[0]> = {}) {
    return buildNightlyRegisterScript(makeOpts(overrides));
  }

  it('registers the Glean\\Nightly task (separate from Glean\\Drain)', () => {
    const script = build();
    expect(script).toContain(NIGHTLY_TASK_NAME); // 'Glean\\Nightly'
    expect(script).not.toContain(TASK_NAME);     // never touches Glean\Drain
  });

  it('uses a DAILY trigger (not weekly)', () => {
    const script = build();
    expect(script).toContain('-Daily');
    expect(script).not.toContain('-Weekly');
  });

  it('runs node <cliEntry> run --drain --project <path> (no .cmd shim)', () => {
    const script = build({ projectPath: 'C:\\Projects\\app' });
    expect(script).toContain('run --drain --project');
    expect(script).toContain('C:\\Projects\\app');
    expect(script).not.toContain('glean.cmd');
  });

  it('defaults to a nightly time and respects an override', () => {
    expect(build()).toContain(`"${DEFAULT_NIGHTLY_TIME}"`);
    expect(build({ time: '02:15' })).toContain('"02:15"');
  });

  it('registers with -Force for idempotency', () => {
    expect(build()).toContain('Register-ScheduledTask');
    expect(build()).toContain('-Force');
  });

  it('validates day/time (injection hardening, like the weekly builder)', () => {
    expect(() => build({ time: '$(calc)' })).toThrow(/time/i);
    expect(() => build({ time: '25:00' })).toThrow(/time/i);
  });

  it('is pure + deterministic', () => {
    const opts = makeOpts();
    expect(buildNightlyRegisterScript(opts)).toBe(buildNightlyRegisterScript(opts));
  });
});

describe('nightly status / unregister builders — split path + leaf', () => {
  it('buildNightlyStatusScript queries by -TaskPath \\Glean\\ + -TaskName Nightly', () => {
    const script = buildNightlyStatusScript();
    expect(script).toContain("Get-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Nightly'");
    expect(script).not.toContain("-TaskName 'Glean\\Nightly'");
  });

  it('buildNightlyUnregisterCommand deletes by split path + leaf', () => {
    const cmd = buildNightlyUnregisterCommand();
    expect(cmd).toContain("Unregister-ScheduledTask -TaskPath '\\Glean\\' -TaskName 'Nightly'");
    expect(cmd).toContain('-Confirm:$false');
  });
});

// ===========================================================================
// Linux scheduling — pure builders. These run on every OS (including Windows
// CI): they only generate strings, mirroring the buildRegisterScript contract.
// ===========================================================================

function makeLinuxOpts(overrides: Partial<Parameters<typeof buildSystemdUnit>[0]> = {}) {
  return {
    nodePath:    '/usr/bin/node',
    cliEntry:    '/home/user/.npm-global/lib/node_modules/@jonny-boy9000/glean/bin/glean.js',
    projectPath: '/home/user/code/myproject',
    day:         'Thursday',
    ...overrides,
  };
}

describe('buildSystemdUnit — glean-drain.service', () => {
  it('is a oneshot service running node <cliEntry> run --drain --project <path>', () => {
    const unit = buildSystemdUnit(makeLinuxOpts());
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/user/.npm-global/lib/node_modules/@jonny-boy9000/glean/bin/glean.js" run --drain --project "/home/user/code/myproject"',
    );
  });

  it('quotes paths so spaces survive systemd ExecStart parsing', () => {
    const unit = buildSystemdUnit(makeLinuxOpts({ projectPath: '/home/user/my projects/app' }));
    expect(unit).toContain('"/home/user/my projects/app"');
  });

  it('has a [Unit] description and is deterministic', () => {
    const opts = makeLinuxOpts();
    expect(buildSystemdUnit(opts)).toContain('[Unit]');
    expect(buildSystemdUnit(opts)).toBe(buildSystemdUnit(opts));
  });
});

describe('buildTimerUnit — glean-drain.timer', () => {
  it('fires weekly at <Day> <time> with Persistent=true (missed-run catch-up after sleep)', () => {
    const timer = buildTimerUnit(makeLinuxOpts());
    expect(timer).toContain('OnCalendar=Thu 18:00');
    expect(timer).toContain('Persistent=true');
  });

  it('maps full day names to systemd short days', () => {
    expect(buildTimerUnit(makeLinuxOpts({ day: 'Friday' }))).toContain('OnCalendar=Fri 18:00');
    expect(buildTimerUnit(makeLinuxOpts({ day: 'Wednesday' }))).toContain('OnCalendar=Wed 18:00');
  });

  it('respects a custom time', () => {
    expect(buildTimerUnit(makeLinuxOpts({ time: '22:30' }))).toContain('OnCalendar=Thu 22:30');
  });

  it('activates the service unit and installs into timers.target', () => {
    const timer = buildTimerUnit(makeLinuxOpts());
    expect(timer).toContain(`Unit=${SYSTEMD_SERVICE}`);
    expect(timer).toContain('WantedBy=timers.target');
  });
});

describe('buildCrontabLine — systemd-unavailable fallback', () => {
  it('repeats hourly through the drain window: 0 18-23,0-6 * * 4,5,6 for Thursday 18:00', () => {
    const line = buildCrontabLine(makeLinuxOpts());
    expect(line.startsWith('0 18-23,0-6 * * 4,5,6 ')).toBe(true);
  });

  it('shifts the day-of-week triple for a Friday start (5,6,0)', () => {
    const line = buildCrontabLine(makeLinuxOpts({ day: 'Friday' }));
    expect(line).toContain('* * 5,6,0 ');
  });

  it('derives minute + start hour from the time (22:30 → 30 22-23,0-6)', () => {
    const line = buildCrontabLine(makeLinuxOpts({ time: '22:30' }));
    expect(line.startsWith('30 22-23,0-6 ')).toBe(true);
  });

  it('runs the same node+cli drain command, quoted, and carries the idempotency marker', () => {
    const line = buildCrontabLine(makeLinuxOpts({ projectPath: '/home/user/my projects/app' }));
    expect(line).toContain('"/usr/bin/node"');
    expect(line).toContain('run --drain --project "/home/user/my projects/app"');
    expect(line.trimEnd().endsWith(CRON_MARKER)).toBe(true);
  });

  it('is a single line', () => {
    expect(buildCrontabLine(makeLinuxOpts()).trim()).not.toContain('\n');
  });
});

describe('mergeCrontabLines / stripCrontabLines — idempotent crontab editing', () => {
  const line = buildCrontabLine(makeLinuxOpts());

  it('appends to an empty crontab with a trailing newline (crontab(1) requires it)', () => {
    const merged = mergeCrontabLines('', line);
    expect(merged).toBe(line + '\n');
  });

  it('preserves unrelated lines and appends ours', () => {
    const existing = '0 5 * * * /usr/bin/backup.sh\n';
    const merged = mergeCrontabLines(existing, line);
    expect(merged).toContain('/usr/bin/backup.sh');
    expect(merged).toContain(line);
  });

  it('replaces a previous glean-drain line instead of duplicating (idempotent enable)', () => {
    const old = buildCrontabLine(makeLinuxOpts({ time: '20:00' }));
    const merged = mergeCrontabLines(old + '\n', line);
    expect(merged).not.toContain('20-23');
    const occurrences = merged.split(CRON_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });

  it('stripCrontabLines removes only the marked line', () => {
    const existing = `0 5 * * * /usr/bin/backup.sh\n${line}\n`;
    const stripped = stripCrontabLines(existing);
    expect(stripped).toContain('/usr/bin/backup.sh');
    expect(stripped).not.toContain(CRON_MARKER);
  });

  it('stripCrontabLines returns empty string when only our line was present', () => {
    expect(stripCrontabLines(line + '\n')).toBe('');
  });
});

describe('parseListTimers — systemctl --user list-timers output', () => {
  it('parses NEXT and LAST timestamps from a live timer row', () => {
    const raw =
      'NEXT                          LEFT       LAST                          PASSED  UNIT               ACTIVATES\n' +
      'Thu 2026-06-18 18:00:00 IDT   6 days     Thu 2026-06-11 18:00:00 IDT   23h ago glean-drain.timer  glean-drain.service\n' +
      '\n1 timers listed.\n';
    const res = parseListTimers(raw);
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.next).toBe('Thu 2026-06-18 18:00:00 IDT');
      expect(res.last).toBe('Thu 2026-06-11 18:00:00 IDT');
    }
  });

  it('handles a never-run timer (n/a LAST)', () => {
    const raw =
      'NEXT                          LEFT     LAST  PASSED  UNIT               ACTIVATES\n' +
      'Thu 2026-06-18 18:00:00 UTC   6 days   n/a   n/a     glean-drain.timer  glean-drain.service\n';
    const res = parseListTimers(raw);
    expect(res.found).toBe(true);
    if (res.found) {
      expect(res.next).toBe('Thu 2026-06-18 18:00:00 UTC');
      expect(res.last).toBe('never');
    }
  });

  it('returns found:false when the timer is absent (empty / no-match output)', () => {
    expect(parseListTimers('').found).toBe(false);
    expect(parseListTimers('0 timers listed.\n').found).toBe(false);
    expect(
      parseListTimers('NEXT LEFT LAST PASSED UNIT ACTIVATES\nMon 2026-06-15 00:00:00 UTC 3d n/a n/a other.timer other.service\n').found,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Linux exec wrappers — only meaningful on a real Linux box (mirror of the
// winOnly live-PowerShell block above). Skipped on win32/darwin.
// ---------------------------------------------------------------------------

describe('linux exec wrappers (live)', () => {
  const linuxOnly = process.platform === 'linux' ? it : it.skip;

  linuxOnly('systemdUserAvailable() returns a boolean without throwing', async () => {
    const { systemdUserAvailable } = await import('./schedule.js');
    expect(typeof systemdUserAvailable()).toBe('boolean');
  });

  linuxOnly('scheduleStatus() runs without throwing when nothing is registered', async () => {
    const { scheduleStatus } = await import('./schedule.js');
    expect(() => scheduleStatus()).not.toThrow();
  });

  it(`unit names are stable (${SYSTEMD_TIMER})`, () => {
    expect(SYSTEMD_TIMER).toBe('glean-drain.timer');
    expect(SYSTEMD_SERVICE).toBe('glean-drain.service');
  });
});
