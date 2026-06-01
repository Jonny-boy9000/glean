import { spawn, execFile, ChildProcess } from 'node:child_process';

export type Job = {
  pid: number | undefined;
  child: ChildProcess;
  exit: Promise<number>;
  // F7: kill resolves only after the descendant tree-kill has completed AND the
  // child has exited, so callers can sequence post-kill cleanup (e.g. clearing a
  // stale index.lock) strictly after no live process can still hold the lock.
  kill: () => Promise<void>;
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

  const kill = (): Promise<void> => {
    if (!child.pid) return Promise.resolve();
    if (process.platform === 'win32') {
      // taskkill /T = tree, /F = force; per Task 2 decision the default approach.
      // Resolve only after taskkill returns AND the child process has exited, so
      // descendants are guaranteed gone before the caller proceeds (F7).
      const treeKilled = new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
          resolve(); // ignore errors — best effort
        });
      });
      return Promise.all([treeKilled, exit]).then(() => undefined);
    }
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = process group
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    return exit.then(() => undefined);
  };

  return { pid: child.pid, child, exit, kill };
}
