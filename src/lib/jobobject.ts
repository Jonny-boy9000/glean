import { spawn, execFile, ChildProcess } from 'node:child_process';

export type Job = {
  pid: number | undefined;
  child: ChildProcess;
  exit: Promise<number>;
  // F7: kill resolves only after the descendant tree-kill has completed AND the
  // child has exited, so callers can sequence post-kill cleanup (e.g. clearing a
  // stale index.lock) strictly after no live process can still hold the lock.
  // INVARIANT[ADR-0004]: if the terminate request fails to actually kill the
  // child, this promise NEVER resolves — callers must bound their wait (the
  // executor's kill grace) instead of awaiting it unconditionally.
  kill: () => Promise<void>;
};

// The platform-specific tree-terminate REQUEST. Resolves when the request has
// been issued/completed (taskkill returned / signal sent) — NOT when the child
// has exited; kill() composes this with the exit promise. Injectable via the
// fn.impl pattern (like executor's diffStat) so tests can simulate a kill that
// fails to terminate the tree — the failure mode the 2026-06-12 live run
// surfaced (ADR-0004) — and assert the executor stays bounded under it.
function terminateTreeImpl(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    // taskkill /T = tree, /F = force; per Task 2 decision the default approach.
    return new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        resolve(); // ignore errors — best effort
      });
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // negative pid = process group
  } catch {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  return Promise.resolve();
}
function terminateTree(child: ChildProcess): Promise<void> {
  return terminateTree.impl(child);
}
terminateTree.impl = terminateTreeImpl;

// Test-only handle (prefixed __ to signal "do not use in production code").
export const __terminateTree = terminateTree;

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
    // POSIX: detached puts the child in its OWN process group, so kill() can
    // reap the whole tree via process.kill(-pid). Without it the child shares
    // glean's group and the negative-pid kill fails (leaving grandchildren
    // alive) — or worse. Windows keeps detached:false (taskkill /T handles
    // the tree there, and detached changes console semantics).
    detached: process.platform !== 'win32',
  });

  const exit = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });

  const kill = (): Promise<void> => {
    if (!child.pid) return Promise.resolve();
    // Resolve only after the tree-terminate request completed AND the child
    // process has exited, so descendants are guaranteed gone before the caller
    // proceeds (F7).
    return Promise.all([terminateTree(child), exit]).then(() => undefined);
  };

  return { pid: child.pid, child, exit, kill };
}
