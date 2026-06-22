/**
 * schedule.ts — scheduled weekly drain for `glean schedule`.
 *
 *   - win32: Windows Task Scheduler (the original, live-validated path).
 *   - linux: systemd USER timer (glean-drain.timer + glean-drain.service in
 *     ~/.config/systemd/user/), with a crontab fallback when systemd --user
 *     is unavailable.
 *   - darwin (launchd): not yet — enable/disable/status throw.
 *
 * DESIGN (both platforms):
 *   - build*() are pure functions that return script/unit/crontab strings.
 *     They can be unit-tested on any OS without touching it.
 *   - enableSchedule() / disableSchedule() / scheduleStatus() are thin exec
 *     wrappers that dispatch on process.platform.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './state.js';

export const TASK_NAME = 'Glean\\Drain';
// Register-ScheduledTask accepts the combined "folder\name" form in -TaskName and
// auto-creates the \Glean folder. But the READ/DELETE cmdlets (Get-ScheduledTask,
// Get-ScheduledTaskInfo, Unregister-ScheduledTask) do NOT match the combined form —
// they need the folder and leaf split into -TaskPath + -TaskName. Querying with the
// combined 'Glean\Drain' returns nothing, so `glean schedule status` misreported a
// registered task as "not registered" (found live on Windows, 2026-06-02).
export const TASK_PATH = '\\Glean\\';
export const TASK_LEAF = 'Drain';

// PIECE 3: a SEPARATE daily task that runs `glean run --drain` every night. The
// drain self-gates on the pacing tier (pace-skip when there's no slack), so a
// daily fire is safe and only spends capacity when the user is under pace. The
// weekly Glean\Drain task is untouched.
export const NIGHTLY_TASK_NAME = 'Glean\\Nightly';
export const NIGHTLY_TASK_PATH = '\\Glean\\';
export const NIGHTLY_TASK_LEAF = 'Nightly';
// A nightly drain fires in the small hours, when the machine is most idle.
export const DEFAULT_NIGHTLY_TIME = '02:00';

// Defaults mirrored in the spec.
export const DEFAULT_TIME           = '18:00';
export const DEFAULT_REPEAT_MINUTES = 60;
export const DEFAULT_DURATION_HOURS = 60;

export type TriggerDay = 'Thursday' | 'Friday';

// Timezones whose work week runs Sunday–Thursday, so the LAST work day is Thursday.
// Most former Sun–Thu countries have moved to Fri–Sat or Sat–Sun weekends; Israel
// is the main remaining case. Expand this set only if a user reports a missing zone.
const SUN_THU_ZONES = new Set<string>(['Asia/Jerusalem']);

// The default weekly drain-trigger day = the end of the LAST work day, when the
// week's Claude capacity is most idle. Sun–Thu work weeks (Israel) → Thursday;
// everyone else (including 'UTC' / unknown) → Friday. `tz` is a call-time default
// param so this is unit-testable by passing a fixed zone — no Intl mocking and no
// dependence on the machine's real locale.
export function defaultTriggerDay(
  tz: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): TriggerDay {
  return SUN_THU_ZONES.has(tz) ? 'Thursday' : 'Friday';
}

// ── F3: PowerShell injection hardening ──────────────────────────────────────
// day/time reach the generated script unquoted/quoted, and paths were escaped
// for `"` only. These values come from CLI flags / config.json (defense-in-depth,
// not the web surface), but an unvalidated value is a real injection. Validate
// day/time against strict whitelists, and neutralize PowerShell's interpolation
// metacharacters (`"`, backtick, `$`) inside double-quoted interpolated paths so
// a `$(...)` subexpression or backtick escape cannot execute.

const WEEKDAYS = new Set<string>([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);

/** Throws unless `day` is one of the seven capitalized weekday names. */
export function assertValidDay(day: string): void {
  if (!WEEKDAYS.has(day)) {
    throw new Error(
      `invalid schedule day '${day}' — must be one of: ${[...WEEKDAYS].join(', ')}`,
    );
  }
}

/** Throws unless `time` is a 24-hour HH:MM string (00:00–23:59). */
export function assertValidTime(time: string): void {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new Error(`invalid schedule time '${time}' — must be 24-hour HH:MM (e.g. 18:00)`);
  }
}

/**
 * Escape a string for safe interpolation inside a PowerShell double-quoted
 * string. Backtick is PowerShell's escape char, so it must come FIRST, then `$`
 * (kills `$(...)` subexpressions + `$var`) and `"` (string break-out). Paths can
 * legitimately contain none of these, so this only ever neutralizes an attack.
 */
export function psDoubleQuoteEscape(s: string): string {
  return s.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
}

export type BuildRegisterScriptOpts = {
  /** Absolute path to the `node` executable (process.execPath at call time). */
  nodePath: string;
  /** Absolute path to `bin/glean.js` in the install. */
  cliEntry: string;
  /** Absolute path to the project repo this drain run targets. */
  projectPath: string;
  /** Day of week for the weekly trigger, e.g. 'Thursday'. */
  day?: string;
  /** Local 24-h HH:MM start time for the weekly trigger, e.g. '18:00'. */
  time?: string;
  /** Repetition interval in minutes inside the trigger window. */
  repeatMinutes?: number;
  /** Duration in hours that the repetition window stays active. */
  durationHours?: number;
};

/**
 * Returns a complete PowerShell script that registers the `Glean\Drain`
 * scheduled task.  The script is idempotent: if the task already exists
 * it is replaced (Register-ScheduledTask -Force).
 *
 * This is a pure function — it produces a string and touches nothing.
 */
export function buildRegisterScript(opts: BuildRegisterScriptOpts): string {
  const day            = opts.day            ?? defaultTriggerDay();
  const time           = opts.time           ?? DEFAULT_TIME;
  const repeatMinutes  = opts.repeatMinutes  ?? DEFAULT_REPEAT_MINUTES;
  const durationHours  = opts.durationHours  ?? DEFAULT_DURATION_HOURS;

  // F3: validate the interpolated-unquoted/quoted scalars before they reach the
  // script (day is interpolated bare into -DaysOfWeek; time into -At "...").
  assertValidDay(day);
  assertValidTime(time);

  // Escape PowerShell interpolation metachars in paths (`"`, backtick, `$`) so a
  // `$(...)` subexpression or backtick escape in a path cannot execute (F3).
  const safeNode    = psDoubleQuoteEscape(opts.nodePath);
  const safeCli     = psDoubleQuoteEscape(opts.cliEntry);
  const safeProject = psDoubleQuoteEscape(opts.projectPath);

  // Convert durationHours to a TimeSpan string understood by New-ScheduledTaskTrigger.
  // PT60H → ISO 8601 period, or we can use the direct cmdlet param format.
  // PowerShell New-ScheduledTaskTrigger accepts -RandomDelay as a TimeSpan string.
  // For RepetitionInterval and RepetitionDuration we pass TimeSpan strings.
  const repeatInterval = `([TimeSpan]::FromMinutes(${repeatMinutes}))`;
  const repeatDuration = `([TimeSpan]::FromHours(${durationHours}))`;

  return `
# Glean Drain — register Windows Scheduled Task
# Generated by glean schedule enable

$ErrorActionPreference = 'Stop'

$action = New-ScheduledTaskAction \`
  -Execute "${safeNode}" \`
  -Argument "\`"${safeCli}\`" run --drain --project \`"${safeProject}\`""

$trigger = New-ScheduledTaskTrigger \`
  -Weekly \`
  -DaysOfWeek ${day} \`
  -At "${time}"

# Repetition sub-properties (.Repetition.Interval/.Duration) are READ-ONLY on a
# weekly trigger in PowerShell 7 — assigning them throws. The reliable pattern is
# to build the repetition from a throwaway -Once trigger and assign the whole
# .Repetition object. Verified live against PowerShell 7 (Interval=PT1H etc.).
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At "${time}" \`
  -RepetitionInterval ${repeatInterval} \`
  -RepetitionDuration ${repeatDuration}).Repetition

$settings = New-ScheduledTaskSettingsSet \`
  -StartWhenAvailable \`
  -AllowStartIfOnBatteries \`
  -DontStopIfGoingOnBatteries \`
  -MultipleInstances IgnoreNew \`
  -WakeToRun:$false \`
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal \`
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) \`
  -LogonType Interactive \`
  -RunLevel Limited

# Register-ScheduledTask -Force auto-creates the \\Glean subfolder; no COM needed.
Register-ScheduledTask \`
  -TaskName "${TASK_NAME}" \`
  -Action $action \`
  -Trigger $trigger \`
  -Settings $settings \`
  -Principal $principal \`
  -Force | Out-Null

Write-Host "Glean\\Drain task registered. Next run: ${day} at ${time} (repeats every ${repeatMinutes}min for ${durationHours}h)."
`.trimStart();
}

/**
 * PIECE 3: PowerShell that registers the daily `Glean\Nightly` task running
 * `glean run --drain`. Pure (returns a string). Idempotent via -Force. Only
 * `time` is configurable; the trigger is -Daily. Validates time (and day, if
 * supplied) with the same whitelists as the weekly builder.
 */
export function buildNightlyRegisterScript(opts: BuildRegisterScriptOpts): string {
  const time = opts.time ?? DEFAULT_NIGHTLY_TIME;
  assertValidTime(time);

  const safeNode    = psDoubleQuoteEscape(opts.nodePath);
  const safeCli     = psDoubleQuoteEscape(opts.cliEntry);
  const safeProject = psDoubleQuoteEscape(opts.projectPath);

  return `
# Glean Nightly — register daily pace-gated drain task
# Generated by glean schedule enable --nightly

$ErrorActionPreference = 'Stop'

$action = New-ScheduledTaskAction \`
  -Execute "${safeNode}" \`
  -Argument "\`"${safeCli}\`" run --drain --project \`"${safeProject}\`""

$trigger = New-ScheduledTaskTrigger \`
  -Daily \`
  -At "${time}"

$settings = New-ScheduledTaskSettingsSet \`
  -StartWhenAvailable \`
  -AllowStartIfOnBatteries \`
  -DontStopIfGoingOnBatteries \`
  -MultipleInstances IgnoreNew \`
  -WakeToRun:$false \`
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal \`
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) \`
  -LogonType Interactive \`
  -RunLevel Limited

Register-ScheduledTask \`
  -TaskName "${NIGHTLY_TASK_NAME}" \`
  -Action $action \`
  -Trigger $trigger \`
  -Settings $settings \`
  -Principal $principal \`
  -Force | Out-Null

Write-Host "Glean\\Nightly task registered. Runs daily at ${time} (pace-gated: spends only when under weekly pace)."
`.trimStart();
}

/** Pure — PowerShell to unregister the Glean\Nightly task (split path + leaf). */
export function buildNightlyUnregisterCommand(): string {
  return `Unregister-ScheduledTask -TaskPath '${NIGHTLY_TASK_PATH}' -TaskName '${NIGHTLY_TASK_LEAF}' -Confirm:$false -ErrorAction SilentlyContinue`;
}

/** Pure — PowerShell that reads Glean\Nightly status (split path + leaf). */
export function buildNightlyStatusScript(): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$t = Get-ScheduledTask -TaskPath '${NIGHTLY_TASK_PATH}' -TaskName '${NIGHTLY_TASK_LEAF}' 2>$null
if (-not $t) { Write-Output 'NOT_FOUND'; exit 0 }
$info = Get-ScheduledTaskInfo -TaskPath '${NIGHTLY_TASK_PATH}' -TaskName '${NIGHTLY_TASK_LEAF}' 2>$null
$state = $t.State
$lastRun = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { 'never' }
$nextRun = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { 'unknown' }
Write-Output "FOUND|$state|$lastRun|$nextRun"
`.trim();
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    throw new Error(
      'glean schedule supports Windows (Task Scheduler) and Linux (systemd user timer / crontab fallback); macOS launchd is future work',
    );
  }
}

export type EnableScheduleOpts = BuildRegisterScriptOpts;

/**
 * Registers (or replaces) the weekly drain schedule.
 * win32: Glean\Drain scheduled task. linux: systemd user timer (or crontab).
 * Throws on unsupported platforms or if the platform tool exits non-zero.
 */
export function enableSchedule(opts: EnableScheduleOpts): void {
  assertSupportedPlatform();
  if (process.platform === 'linux') {
    enableScheduleLinux(opts);
    return;
  }
  const script = buildRegisterScript(opts);
  execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', script], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
}

/**
 * Unregisters the Glean\Drain scheduled task.
 * A no-op (exit 0) if the task does not exist.
 */
// Pure (testable) — the PowerShell to unregister the task. Uses the split
// -TaskPath/-TaskName form because Unregister-ScheduledTask does not match the
// combined 'Glean\Drain' that Register accepts.
export function buildUnregisterCommand(): string {
  return `Unregister-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName '${TASK_LEAF}' -Confirm:$false -ErrorAction SilentlyContinue`;
}

export function disableSchedule(): void {
  assertSupportedPlatform();
  if (process.platform === 'linux') {
    disableScheduleLinux();
    return;
  }
  const cmd = buildUnregisterCommand();
  execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', cmd], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  console.log(`Glean\\Drain task removed (or was not present).`);
}

export type ScheduleStatusResult =
  | { found: false }
  | { found: true; state: string; lastRun: string; nextRun: string; taskName: string };

/**
 * Returns the current status of the Glean\Drain task.
 * Returns { found: false } when the task does not exist.
 */
// Pure (testable) — the PowerShell that reads task status. Uses the split
// -TaskPath/-TaskName form: Get-ScheduledTask / Get-ScheduledTaskInfo do not match
// the combined 'Glean\Drain' that Register accepts (the status-misreport bug).
export function buildStatusScript(): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$t = Get-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName '${TASK_LEAF}' 2>$null
if (-not $t) { Write-Output 'NOT_FOUND'; exit 0 }
$info = Get-ScheduledTaskInfo -TaskPath '${TASK_PATH}' -TaskName '${TASK_LEAF}' 2>$null
$state = $t.State
$lastRun = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { 'never' }
$nextRun = if ($info.NextRunTime) { $info.NextRunTime.ToString('o') } else { 'unknown' }
Write-Output "FOUND|$state|$lastRun|$nextRun"
`.trim();
}

export function scheduleStatus(): ScheduleStatusResult {
  assertSupportedPlatform();
  if (process.platform === 'linux') return scheduleStatusLinux();

  const cmd = buildStatusScript();

  let raw: string;
  try {
    raw = execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
  } catch {
    return { found: false };
  }

  if (!raw || raw === 'NOT_FOUND') return { found: false };

  const parts = raw.split('|');
  if (parts.length < 4) return { found: false };
  return {
    found: true,
    taskName: TASK_NAME,
    state: parts[1],
    lastRun: parts[2],
    nextRun: parts[3],
  };
}

// ===========================================================================
// PIECE 3: nightly pace-gated drain — exec wrappers (Windows). Mirrors the
// weekly enable/disable/status, but registers the separate Glean\Nightly task.
// Linux nightly is not yet wired (the weekly systemd path stays the only Linux
// schedule); enable/disable/status throw a clear message there.
// ===========================================================================

function assertNightlySupported(): void {
  if (process.platform !== 'win32') {
    throw new Error(
      'glean schedule enable --nightly is Windows-only for now (the Linux schedule is the weekly systemd timer / crontab path)',
    );
  }
}

/** Registers (or replaces) the daily Glean\Nightly pace-gated drain task. */
export function enableNightlySchedule(opts: EnableScheduleOpts): void {
  assertNightlySupported();
  const script = buildNightlyRegisterScript(opts);
  execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', script], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
}

/** Unregisters the Glean\Nightly task (no-op if absent). */
export function disableNightlySchedule(): void {
  assertNightlySupported();
  execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', buildNightlyUnregisterCommand()], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  console.log('Glean\\Nightly task removed (or was not present).');
}

/** Returns the current status of the Glean\Nightly task. */
export function nightlyScheduleStatus(): ScheduleStatusResult {
  assertNightlySupported();
  let raw: string;
  try {
    raw = execFileSync('powershell', ['-NonInteractive', '-NoProfile', '-Command', buildNightlyStatusScript()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
  } catch {
    return { found: false };
  }
  if (!raw || raw === 'NOT_FOUND') return { found: false };
  const parts = raw.split('|');
  if (parts.length < 4) return { found: false };
  return { found: true, taskName: NIGHTLY_TASK_NAME, state: parts[1], lastRun: parts[2], nextRun: parts[3] };
}

// ===========================================================================
// Linux — systemd user timer (primary) + crontab (fallback)
// ===========================================================================

export const SYSTEMD_SERVICE = 'glean-drain.service';
export const SYSTEMD_TIMER = 'glean-drain.timer';
/** Idempotency marker appended to the crontab line so enable/disable can find it. */
export const CRON_MARKER = '# glean-drain';

// systemd's abbreviated weekday names (OnCalendar accepts both, but emit the
// canonical short form). Keys are the full names the CLI/config already use.
const SYSTEMD_DAYS: Record<string, string> = {
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
};
// cron day-of-week numbers (0 = Sunday).
const CRON_DAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function systemdDay(day: string): string {
  return SYSTEMD_DAYS[day.toLowerCase()] ?? 'Fri';
}

/** ~/.config/systemd/user — `home` is injectable for tests. */
export function systemdUserDir(home: string = homeDir()): string {
  return join(home, '.config', 'systemd', 'user');
}

/** The drain command shared by the service unit and the crontab line. */
function drainCommand(opts: BuildRegisterScriptOpts): string {
  return `"${opts.nodePath}" "${opts.cliEntry}" run --drain --project "${opts.projectPath}"`;
}

/**
 * Pure — glean-drain.service: a oneshot unit running one drain tick.
 * Activated by the timer (and re-activatable by hand: systemctl --user start).
 */
export function buildSystemdUnit(opts: BuildRegisterScriptOpts): string {
  return `[Unit]
Description=Glean drain tick (consume idle Claude capacity; one burst per activation)

[Service]
Type=oneshot
ExecStart=${drainCommand(opts)}
`;
}

/**
 * Pure — glean-drain.timer: weekly OnCalendar=<Day> <time>.
 *
 * The Windows task's hourly-repetition-for-60h window is approximated here by
 * a single weekly fire + Persistent=true: laptops sleep at lid-close, and
 * Persistent=true is what re-fires a missed activation on wake — the hard
 * requirement (glean's drain relies on external re-launch). A drain tick that
 * exits early on a 5-hour rate limit is NOT re-launched until next week on
 * this path — the crontab fallback keeps hourly re-entry; revisit if the
 * single-fire approximation proves too lossy in practice.
 */
export function buildTimerUnit(opts: BuildRegisterScriptOpts): string {
  const day = systemdDay(opts.day ?? defaultTriggerDay());
  const time = opts.time ?? DEFAULT_TIME;
  return `[Unit]
Description=Glean weekly drain timer

[Timer]
OnCalendar=${day} ${time}
Persistent=true
Unit=${SYSTEMD_SERVICE}

[Install]
WantedBy=timers.target
`;
}

/**
 * Pure — crontab fallback when systemd --user is unavailable: hourly re-entry
 * through the drain window, e.g. `0 18-23,0-6 * * 4,5,6` for Thursday 18:00
 * (Thu/Fri/Sat evenings + small hours — approximates the 60h Windows window).
 */
export function buildCrontabLine(opts: BuildRegisterScriptOpts): string {
  const day = opts.day ?? defaultTriggerDay();
  const time = opts.time ?? DEFAULT_TIME;
  const [hh, mm] = time.split(':');
  const startHour = Number(hh) || 0;
  const minute = Number(mm) || 0;
  const startDow = CRON_DAYS[day.toLowerCase()] ?? 5;
  const days = [startDow, (startDow + 1) % 7, (startDow + 2) % 7].join(',');
  const hours = `${startHour}-23,0-6`;
  return `${minute} ${hours} * * ${days} ${drainCommand(opts)} ${CRON_MARKER}`;
}

/** Pure — existing crontab text + our line, replacing any previous glean-drain line. */
export function mergeCrontabLines(existing: string, line: string): string {
  const kept = stripCrontabLines(existing);
  return (kept ? kept.replace(/\n?$/, '\n') : '') + line + '\n';
}

/** Pure — existing crontab text with any glean-drain marked line removed. */
export function stripCrontabLines(existing: string): string {
  const lines = existing.split(/\r?\n/).filter((l) => !l.includes(CRON_MARKER));
  const out = lines.join('\n').replace(/\n+$/, '');
  return out ? out + '\n' : '';
}

export type ListTimersResult = { found: false } | { found: true; next: string; last: string };

/**
 * Pure — parse `systemctl --user list-timers glean-drain.timer` output.
 * Lenient: finds the glean-drain.timer row and pulls the (up to) two
 * `Day YYYY-MM-DD HH:MM:SS TZ` timestamps in column order (NEXT, then LAST).
 */
export function parseListTimers(raw: string): ListTimersResult {
  const row = raw.split(/\r?\n/).find((l) => l.includes(SYSTEMD_TIMER));
  if (!row) return { found: false };
  const stamps = row.match(/[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: \S+)?/g) ?? [];
  return { found: true, next: stamps[0] ?? 'unknown', last: stamps[1] ?? 'never' };
}

/**
 * True when a systemd user manager is reachable for this login session.
 * `systemctl --user show-environment` exits non-zero (or systemctl is absent)
 * on systemd-less boxes, containers, and sessions without a user bus.
 */
export function systemdUserAvailable(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function systemctlUser(args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return ''; // `crontab -l` exits non-zero when the user has no crontab yet
  }
}

function writeCrontab(content: string): void {
  execFileSync('crontab', ['-'], { input: content, stdio: ['pipe', 'inherit', 'inherit'] });
}

function enableScheduleLinux(opts: EnableScheduleOpts): void {
  const day = opts.day ?? defaultTriggerDay();
  const time = opts.time ?? DEFAULT_TIME;
  if (systemdUserAvailable()) {
    const dir = systemdUserDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SYSTEMD_SERVICE), buildSystemdUnit(opts));
    writeFileSync(join(dir, SYSTEMD_TIMER), buildTimerUnit(opts));
    systemctlUser(['daemon-reload']);
    systemctlUser(['enable', '--now', SYSTEMD_TIMER]);
    console.log(
      `${SYSTEMD_TIMER} enabled: ${systemdDay(day)} ${time} weekly (Persistent=true re-fires a run missed while asleep).`,
    );
  } else {
    writeCrontab(mergeCrontabLines(readCrontab(), buildCrontabLine(opts)));
    console.log(
      `glean drain added to crontab (systemd --user unavailable): hourly through the ${day} ${time} weekend window.`,
    );
  }
}

function disableScheduleLinux(): void {
  if (systemdUserAvailable()) {
    try {
      systemctlUser(['disable', '--now', SYSTEMD_TIMER]);
    } catch {
      /* not enabled — fine */
    }
    const dir = systemdUserDir();
    for (const f of [SYSTEMD_TIMER, SYSTEMD_SERVICE]) {
      try {
        if (existsSync(join(dir, f))) unlinkSync(join(dir, f));
      } catch {
        /* best effort */
      }
    }
    try {
      systemctlUser(['daemon-reload']);
    } catch {
      /* best effort */
    }
  }
  // Always strip the crontab line too — covers a box where the fallback was
  // used before systemd --user became available (or vice versa).
  const existing = readCrontab();
  if (existing.includes(CRON_MARKER)) writeCrontab(stripCrontabLines(existing));
  console.log('glean drain schedule removed (or was not present).');
}

function scheduleStatusLinux(): ScheduleStatusResult {
  if (systemdUserAvailable()) {
    let raw = '';
    try {
      raw = execFileSync('systemctl', ['--user', 'list-timers', SYSTEMD_TIMER, '--all', '--no-pager'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return { found: false };
    }
    const parsed = parseListTimers(raw);
    if (parsed.found) {
      let state = 'registered';
      try {
        state = execFileSync('systemctl', ['--user', 'is-active', SYSTEMD_TIMER], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        state = 'inactive';
      }
      return { found: true, taskName: SYSTEMD_TIMER, state, lastRun: parsed.last, nextRun: parsed.next };
    }
    // fall through: maybe the cron fallback was used on this box
  }
  if (readCrontab().includes(CRON_MARKER)) {
    return {
      found: true,
      taskName: 'glean-drain (crontab)',
      state: 'registered (cron)',
      lastRun: 'unknown (cron keeps no history)',
      nextRun: 'per crontab line — run `crontab -l`',
    };
  }
  return { found: false };
}
