import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR-0010 scheduled-auth: on `glean run --drain`, the stored OAuth token is injected
// into the spawned claude's env as CLAUDE_CODE_OAUTH_TOKEN, and any ANTHROPIC_API_KEY
// (which would override it) is STRIPPED — so a token-less unattended drain can't 401
// and a stray API key can't break the subscription-auth assumption. A plain (non-drain)
// `glean run` must NOT inject (bare path unchanged).

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'glean-v32-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), '// TODO: x\n');
  execSync('git add . && git commit -q -m i', { cwd: repo });
  return repo;
}

function makeHomeWithToken(token: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
  const fakeClaude = process.platform === 'win32'
    ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
    : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
  mkdirSync(join(home, 'glean', 'state'), { recursive: true });
  writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));
  if (token) writeFileSync(join(home, 'glean', 'state', 'auth-token'), token + '\n');
  return home;
}

function readEnvDump(envOut: string): Record<string, string | null> {
  expect(existsSync(envOut)).toBe(true);
  const lines = readFileSync(envOut, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  expect(lines.length).toBeGreaterThanOrEqual(1);
  return JSON.parse(lines[0]) as Record<string, string | null>;
}

describe('verification 32: --drain injects CLAUDE_CODE_OAUTH_TOKEN + strips ANTHROPIC_API_KEY', () => {
  const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'clean-exit.yaml');

  it('--drain: stored token is injected and the API key is stripped from the spawn env', () => {
    const repo = makeRepo();
    const home = makeHomeWithToken('stored-oauth-tok');
    const envOut = join(home, 'env.jsonl');
    const res = spawnSync('node', ['bin/glean.js', 'run', '--drain', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_ENV_OUT: envOut, ANTHROPIC_API_KEY: 'sk-ant-api03-leak' },
      encoding: 'utf8',
    });
    expect([0, 10, 20]).toContain(res.status); // completed / budget / rate-limit are all fine
    const env = readEnvDump(envOut);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-oauth-tok');
    expect(env.ANTHROPIC_API_KEY).toBeNull(); // stripped
  });

  it('plain run (no --drain): does NOT inject and leaves the env untouched', () => {
    const repo = makeRepo();
    const home = makeHomeWithToken('stored-oauth-tok');
    const envOut = join(home, 'env.jsonl');
    const res = spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
      env: { ...process.env, USERPROFILE: home, HOME: home, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_ENV_OUT: envOut, ANTHROPIC_API_KEY: 'sk-ant-api03-leak' },
      encoding: 'utf8',
    });
    expect([0, 10, 20]).toContain(res.status);
    const env = readEnvDump(envOut);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeNull(); // not injected on a plain run
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-leak'); // untouched
  });
});
