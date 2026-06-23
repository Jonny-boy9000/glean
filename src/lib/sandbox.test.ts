import { describe, it, expect } from 'vitest';
import {
  detectSandboxAvailability,
  resolveSpawnPosture,
  buildSandboxSettings,
  SECRET_DENY_READ,
} from './sandbox.js';

describe('detectSandboxAvailability (ADR-0013)', () => {
  it('darwin is always available (Seatbelt is built in)', () => {
    const a = detectSandboxAvailability('darwin', () => false);
    expect(a).toEqual({ available: true, platform: 'darwin', missing: [] });
  });

  it('linux is available only when bwrap AND socat are on PATH', () => {
    expect(detectSandboxAvailability('linux', () => true).available).toBe(true);
    const noBwrap = detectSandboxAvailability('linux', (p) => p !== 'bwrap');
    expect(noBwrap.available).toBe(false);
    expect(noBwrap.missing.join(' ')).toMatch(/bwrap|bubblewrap/);
    const noSocat = detectSandboxAvailability('linux', (p) => p !== 'socat');
    expect(noSocat.available).toBe(false);
    expect(noSocat.missing.join(' ')).toContain('socat');
  });

  it('native Windows is NEVER available (no OS sandbox)', () => {
    const a = detectSandboxAvailability('win32', () => true);
    expect(a.available).toBe(false);
    expect(a.platform).toBe('win32');
    expect(a.missing.join(' ')).toMatch(/Windows/i);
  });

  it('any other platform is unavailable', () => {
    expect(detectSandboxAvailability('aix' as NodeJS.Platform, () => true).available).toBe(false);
  });
});

describe('resolveSpawnPosture (most-restrictive-wins)', () => {
  const AVAIL = { available: true, platform: 'darwin' as const, missing: [] };
  const UNAVAIL = { available: false, platform: 'win32' as const, missing: ['no Windows sandbox'] };

  it('strict_spawn beats everything, regardless of availability', () => {
    expect(resolveSpawnPosture({ strict_spawn: true, enforce_spawn: true }, AVAIL).posture).toBe('strict');
    expect(resolveSpawnPosture({ strict_spawn: true }, UNAVAIL).posture).toBe('strict');
  });

  it('enforce_spawn → enforce when the sandbox is available', () => {
    const r = resolveSpawnPosture({ enforce_spawn: true }, AVAIL);
    expect(r.posture).toBe('enforce');
    expect(r.enforceRequestedButUnavailable).toBe(false);
  });

  it('enforce_spawn on a platform WITHOUT a sandbox falls back to narrow + flags it', () => {
    const r = resolveSpawnPosture({ enforce_spawn: true }, UNAVAIL);
    expect(r.posture).toBe('narrow');
    expect(r.enforceRequestedButUnavailable).toBe(true);
  });

  it('default (neither set) is narrow', () => {
    expect(resolveSpawnPosture({}, AVAIL)).toEqual({ posture: 'narrow', enforceRequestedButUnavailable: false });
  });
});

describe('buildSandboxSettings (the load-bearing --settings JSON)', () => {
  it('confines writes to writeRoot, fails closed, no escape hatch, denies secret reads', () => {
    const json = buildSandboxSettings({ writeRoot: '/work/wt' });
    const obj = JSON.parse(json);
    expect(obj.sandbox.enabled).toBe(true);
    expect(obj.sandbox.failIfUnavailable).toBe(true);          // fail-closed hinge
    expect(obj.sandbox.allowUnsandboxedCommands).toBe(false);  // no dangerouslyDisableSandbox
    expect(obj.sandbox.filesystem.allowWrite).toEqual(['/work/wt']);
    for (const s of SECRET_DENY_READ) expect(obj.sandbox.filesystem.denyRead).toContain(s);
    expect(obj.sandbox.filesystem.denyRead).toContain('~/.ssh');
    expect(obj.sandbox.filesystem.denyRead).toContain('~/.claude/.credentials.json');
  });

  it('adds readScopes as allowRead (e.g. a research project_path) and extra deny paths', () => {
    const obj = JSON.parse(buildSandboxSettings({
      writeRoot: '/work/dossier',
      readScopes: ['/repos/app'],
      denyReadExtra: ['/repos/app-main'],
    }));
    expect(obj.sandbox.filesystem.allowRead).toEqual(['/repos/app']);
    expect(obj.sandbox.filesystem.denyRead).toContain('/repos/app-main');
  });

  it('omits allowRead when there are no readScopes', () => {
    const obj = JSON.parse(buildSandboxSettings({ writeRoot: '/work/wt' }));
    expect(obj.sandbox.filesystem.allowRead).toBeUndefined();
  });

  it('emits a STABLE key order (regression-locked like draftImplAllowedTools)', () => {
    expect(buildSandboxSettings({ writeRoot: '/w' })).toBe(
      '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,'
      + '"filesystem":{"allowWrite":["/w"],"denyRead":['
      + '"~/.ssh","~/.aws","~/.gnupg","~/.config/gcloud","~/.config/gh","~/.npmrc",'
      + '"~/.git-credentials","~/.netrc","~/.claude/.credentials.json"]}}}',
    );
  });
});
