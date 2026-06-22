import { describe, it, expect } from 'vitest';
import { runDoctor, summarizeDoctor, renderDoctor, type DoctorProbes } from './doctor.js';
import type { GleanConfig } from './types.js';

// A baseline "everything works" probe set; individual tests override one field.
function okProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: '20.11.0',
    resolveBin: (name) => `C:\\bin\\${name}.exe`, // every bin resolves
    config: { projects: {} } as GleanConfig,
    configPath: 'C:\\Users\\u\\glean\\config.json',
    configExists: true,
    sqliteOk: () => ({ ok: true }),
    ...overrides,
  };
}

function byId(checks: ReturnType<typeof runDoctor>, id: string) {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check with id ${id}`);
  return c;
}

describe('runDoctor', () => {
  it('all-pass: node ok, claude/git resolved, gh resolved, config present, sqlite ok → every hard check passes', () => {
    const checks = runDoctor(okProbes());
    expect(byId(checks, 'node').status).toBe('pass');
    expect(byId(checks, 'claude').status).toBe('pass');
    expect(byId(checks, 'git').status).toBe('pass');
    expect(byId(checks, 'gh').status).toBe('pass');
    expect(byId(checks, 'sqlite').status).toBe('pass');
    expect(summarizeDoctor(checks).ok).toBe(true);
    expect(summarizeDoctor(checks).exitCode).toBe(0);
  });

  it('node too old → node check FAILS and summary is not ok (exit 1)', () => {
    const checks = runDoctor(okProbes({ nodeVersion: '18.19.0' }));
    expect(byId(checks, 'node').status).toBe('fail');
    expect(byId(checks, 'node').detail).toContain('20');
    const s = summarizeDoctor(checks);
    expect(s.ok).toBe(false);
    expect(s.exitCode).toBe(1);
  });

  it('node exactly 20.0.0 → passes (boundary)', () => {
    const checks = runDoctor(okProbes({ nodeVersion: '20.0.0' }));
    expect(byId(checks, 'node').status).toBe('pass');
  });

  it('missing claude → claude check FAILS (it is the #1 first-run failure)', () => {
    const checks = runDoctor(okProbes({ resolveBin: (name) => (name === 'claude' ? null : `C:\\bin\\${name}.exe`) }));
    expect(byId(checks, 'claude').status).toBe('fail');
    expect(summarizeDoctor(checks).ok).toBe(false);
  });

  it('missing git → git check FAILS', () => {
    const checks = runDoctor(okProbes({ resolveBin: (name) => (name === 'git' ? null : `C:\\bin\\${name}.exe`) }));
    expect(byId(checks, 'git').status).toBe('fail');
    expect(summarizeDoctor(checks).ok).toBe(false);
  });

  it('missing gh → gh check WARNS, not fails (gh is optional)', () => {
    const checks = runDoctor(okProbes({ resolveBin: (name) => (name === 'gh' ? null : `C:\\bin\\${name}.exe`) }));
    expect(byId(checks, 'gh').status).toBe('warn');
    // A warn must NOT flip the summary to failure.
    expect(summarizeDoctor(checks).ok).toBe(true);
    expect(summarizeDoctor(checks).exitCode).toBe(0);
  });

  it('missing config → config check is INFO, never a failure', () => {
    const checks = runDoctor(okProbes({ configExists: false, config: {} as GleanConfig }));
    expect(byId(checks, 'config').status).toBe('info');
    expect(summarizeDoctor(checks).ok).toBe(true);
  });

  it('config with projects reports the project count and draft-impl enablement', () => {
    const config = {
      projects: {
        'C:\\a': { base_branch: 'main' },
        'C:\\b': {},
      },
    } as GleanConfig;
    const checks = runDoctor(okProbes({ configExists: true, config }));
    const c = byId(checks, 'config');
    expect(c.status).toBe('info');
    expect(c.detail).toContain('2');
    // At least one project has base_branch → draft-impl enabled note.
    expect(c.detail.toLowerCase()).toContain('draft-impl');
  });

  it('uses the configured claude_bin when resolving the claude check', () => {
    const seen: string[] = [];
    const checks = runDoctor(
      okProbes({
        config: { claude_bin: 'C:\\custom\\claude.cmd', projects: {} } as GleanConfig,
        resolveBin: (name) => {
          seen.push(name);
          return `C:\\bin\\${name}`;
        },
      }),
    );
    // The claude check resolved the configured binary path, not the bare name.
    expect(seen).toContain('C:\\custom\\claude.cmd');
    expect(byId(checks, 'claude').status).toBe('pass');
  });

  it('broken sqlite → sqlite check WARNS (telemetry/memory will be disabled), not a failure', () => {
    const checks = runDoctor(okProbes({ sqliteOk: () => ({ ok: false, message: 'NODE_MODULE_VERSION mismatch' }) }));
    const c = byId(checks, 'sqlite');
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('NODE_MODULE_VERSION mismatch');
    // A broken native binding must NOT make doctor itself fail.
    expect(summarizeDoctor(checks).ok).toBe(true);
    expect(summarizeDoctor(checks).exitCode).toBe(0);
  });

  it('multiple hard failures still summarize to a single non-zero exit', () => {
    const checks = runDoctor(okProbes({ nodeVersion: '18.0.0', resolveBin: () => null }));
    const s = summarizeDoctor(checks);
    expect(s.ok).toBe(false);
    expect(s.exitCode).toBe(1);
  });
});

describe('renderDoctor', () => {
  it('renders one line per check with a pass/warn/fail marker and a summary', () => {
    const checks = runDoctor(okProbes());
    const out = renderDoctor(checks, false);
    expect(out).toContain('Node');
    expect(out).toContain('claude');
    expect(out).toContain('git');
    // Plain (no-color) output still carries a readable status token per line.
    expect(out.toLowerCase()).toContain('pass');
    // Summary line present.
    expect(out.toLowerCase()).toContain('all');
  });

  it('renders a failure summary when a hard check fails', () => {
    const checks = runDoctor(okProbes({ resolveBin: (name) => (name === 'claude' ? null : `C:\\bin\\${name}`) }));
    const out = renderDoctor(checks, false);
    expect(out.toLowerCase()).toContain('fail');
  });
});
