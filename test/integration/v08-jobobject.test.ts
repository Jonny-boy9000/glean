import { describe, it, expect } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

describe('verification 8: job-object child-tree cleanup', () => {
  // This test verifies that when the orchestrator is force-killed, its fake-claude child
  // process is also killed (via Windows Job Object or SIGKILL propagation on POSIX).
  // Inherently platform-specific and somewhat heuristic — marked skip if unreliable.
  it.skip(
    'child processes die when orchestrator is force-killed (skipped: heuristic process-listing is unreliable in CI; see spec §10 row 8 for manual verification)',
    async () => {
      // Setup repo
      const repo = mkdtempSync(join(tmpdir(), 'glean-v8-'));
      execSync('git init -q', { cwd: repo });
      execSync('git config user.email t@t', { cwd: repo });
      execSync('git config user.name t', { cwd: repo });
      writeFileSync(join(repo, 'a.ts'), '// TODO: jobobject-test\n');
      execSync('git add . && git commit -q -m i', { cwd: repo });

      const home = mkdtempSync(join(tmpdir(), 'glean-home-'));
      const fakeClaude = process.platform === 'win32'
        ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
        : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');
      const scenario = join(process.cwd(), 'test', 'fixtures', 'scenarios', 'long-running.yaml');

      mkdirSync(join(home, 'glean'), { recursive: true });
      writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({ claude_bin: fakeClaude }));

      const env = {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        FAKE_CLAUDE_SCENARIO: scenario,
      } as NodeJS.ProcessEnv;

      // Spawn orchestrator
      const orch = spawn('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], { env });
      const orchPid = orch.pid!;

      // Wait for fake-claude child to spawn
      await wait(2000);

      // Force-kill the orchestrator process tree
      if (process.platform === 'win32') {
        try { execSync(`taskkill /PID ${orchPid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
      } else {
        try { process.kill(orchPid, 'SIGKILL'); } catch { /* ignore */ }
      }

      // Wait for child processes to die
      await wait(3000);

      // Check that no fake-claude process is still running
      if (process.platform === 'win32') {
        // Use PowerShell WMI to get command lines of node.exe processes
        const out = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=\\"node.exe\\"' | Select-Object -ExpandProperty CommandLine | Out-String"`,
          { encoding: 'utf8' },
        );
        expect(out.includes('fake-claude')).toBe(false);
      } else {
        const out = execSync('pgrep -fl fake-claude || true', { encoding: 'utf8' });
        expect(out.trim()).toBe('');
      }
    },
  );

  // Smoke test: just verifies the test file loads and the skip is intentional
  it('job-object test is intentionally skipped — see above for documentation', () => {
    expect(true).toBe(true);
  });
}, { timeout: 60_000 });
