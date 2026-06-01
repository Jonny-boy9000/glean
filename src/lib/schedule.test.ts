import { describe, it, expect } from 'vitest';
import {
  buildRegisterScript,
  DEFAULT_DAY,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default behaviour
// ---------------------------------------------------------------------------

describe('buildRegisterScript — defaults', () => {
  it('uses Thursday + 18:00 by default', () => {
    const script = buildRegisterScript(makeOpts());
    expect(script).toContain(DEFAULT_DAY);        // 'Thursday'
    expect(script).toContain(`"${DEFAULT_TIME}"`); // '"18:00"'
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
