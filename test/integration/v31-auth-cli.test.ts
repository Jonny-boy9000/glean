import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR-0010 scheduled-auth: `glean auth setup-token|status|clear` round-trip.
function runGlean(home: string, args: string[], input?: string) {
  return spawnSync('node', ['bin/glean.js', ...args], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    input,
    encoding: 'utf8',
  });
}

describe('verification 31: glean auth setup-token | status | clear', () => {
  it('stores a piped token, reports it, then clears it', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-auth-home-'));

    // status: none yet
    let r = runGlean(home, ['auth', 'status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/none configured/i);

    // setup-token via stdin (pipe → not a TTY → reads stdin)
    r = runGlean(home, ['auth', 'setup-token'], 'oat-piped-token-xyz\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/stored scheduled-auth token/i);
    const tokenFile = join(home, 'glean', 'state', 'auth-token');
    expect(existsSync(tokenFile)).toBe(true);
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe('oat-piped-token-xyz');

    // status: configured (masked)
    r = runGlean(home, ['auth', 'status']);
    expect(r.stdout).toMatch(/configured/i);
    expect(r.stdout).not.toContain('oat-piped-token-xyz'); // masked, not echoed

    // clear
    r = runGlean(home, ['auth', 'clear']);
    expect(r.stdout).toMatch(/cleared/i);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it('REJECTS an API key (sk-…) — subscription-auth only', () => {
    const home = mkdtempSync(join(tmpdir(), 'glean-auth-home-'));
    const r = runGlean(home, ['auth', 'setup-token'], 'sk-ant-api03-should-be-rejected\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/API key/i);
    expect(existsSync(join(home, 'glean', 'state', 'auth-token'))).toBe(false);
  });
});
