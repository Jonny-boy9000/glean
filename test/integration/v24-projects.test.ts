import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// v0.9 project portfolio: CLI parity for the dashboard's Projects tab.
// `glean projects` lists the registry; `glean projects set <path> <priority>`
// turns the dial, reusing the same lib functions as the API.

function setupHome(): { home: string; repoA: string; repoOff: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'glean-v24-home-'));
  mkdirSync(join(home, 'glean'), { recursive: true });
  const repoA = join(home, 'repoA');
  mkdirSync(join(repoA, '.git'), { recursive: true });
  const repoOff = join(home, 'repoOff');
  mkdirSync(repoOff, { recursive: true });
  const configPath = join(home, 'glean', 'config.json');
  writeFileSync(configPath, JSON.stringify({
    projects: {
      [repoA]: { base_branch: 'main' },
      [repoOff]: { priority: 'off' },
    },
  }));
  return { home, repoA, repoOff, configPath };
}

function runCli(home: string, args: string[]): ReturnType<typeof spawnSync<string>> {
  return spawnSync('node', ['bin/glean.js', ...args], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: 'utf8',
  });
}

describe('verification 24: glean projects CLI', () => {
  it('lists configured projects with their priority dials', () => {
    const { home, repoA, repoOff } = setupHome();
    const res = runCli(home, ['projects']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(repoA);
    expect(res.stdout).toContain(repoOff);
    expect(res.stdout).toContain('normal'); // configured without dial defaults to normal
    expect(res.stdout).toContain('off');
  });

  it('set <path> <priority> updates config.json and round-trips through the list', () => {
    const { home, repoA, configPath } = setupHome();
    const res = runCli(home, ['projects', 'set', repoA, 'high']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('high');
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.projects[repoA].priority).toBe('high');
    expect(cfg.projects[repoA].base_branch).toBe('main'); // other fields survive
    const list = runCli(home, ['projects']);
    expect(list.stdout).toContain('high');
  });

  it('set opts in a new existing path (added to config at the given priority)', () => {
    const { home, configPath } = setupHome();
    const fresh = join(home, 'freshRepo');
    mkdirSync(fresh, { recursive: true });
    const res = runCli(home, ['projects', 'set', fresh, 'low']);
    expect(res.status).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.projects[fresh].priority).toBe('low');
  });

  it('rejects a bad priority with exit 1', () => {
    const { home, repoA } = setupHome();
    const res = runCli(home, ['projects', 'set', repoA, 'urgent']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/priority/);
  });

  it('rejects an unknown, nonexistent path with exit 1', () => {
    const { home } = setupHome();
    const res = runCli(home, ['projects', 'set', join(home, 'ghost'), 'high']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/exist/i);
  });

  it('prints usage and exits 1 when set is missing arguments', () => {
    const { home } = setupHome();
    const res = runCli(home, ['projects', 'set']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('usage');
  });
});
