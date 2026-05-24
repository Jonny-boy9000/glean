import { spawn, execFile, ChildProcess } from 'node:child_process';

export type Job = {
  pid: number | undefined;
  child: ChildProcess;
  exit: Promise<number>;
  kill: () => void;
};

export function spawnInJob(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: 'pipe' | 'inherit' } = {},
): Job {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.stdio ?? 'pipe',
    windowsHide: true,
    detached: false,
  });

  const exit = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });

  const kill = (): void => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      // taskkill /T = tree, /F = force; per Task 2 decision the default approach
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        // ignore errors — best effort
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL'); // negative pid = process group
      } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }
  };

  return { pid: child.pid, child, exit, kill };
}
