import { describe, it, expect, vi } from 'vitest';
import { setTimeout as wait } from 'node:timers/promises';

// We hoist a mock for node:child_process so we can spy on execFile while keeping
// the real spawn (needed by the existing tests and by spawnInJob itself).
// The mock execFile calls through to the real implementation so taskkill actually runs.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFileSpy = vi.fn((...args: Parameters<typeof real.execFile>) => {
    return (real.execFile as (...a: unknown[]) => unknown)(...args);
  });
  return { ...real, execFile: execFileSpy };
});

// Import after the mock is registered so spawnInJob picks up the mocked execFile.
const { spawnInJob } = await import('./jobobject.js');
const { execFile: execFileMock } = await import('node:child_process');

describe('spawnInJob', () => {
  it('runs a short command and reports clean exit', async () => {
    const job = spawnInJob(process.platform === 'win32' ? 'cmd' : 'sh',
      process.platform === 'win32' ? ['/c', 'exit 0'] : ['-c', 'exit 0']);
    const code = await job.exit;
    expect(code).toBe(0);
  });

  it('kills a long-running child tree on .kill()', async () => {
    const job = spawnInJob(process.platform === 'win32' ? 'cmd' : 'sh',
      process.platform === 'win32' ? ['/c', 'timeout', '/t', '30'] : ['-c', 'sleep 30']);
    await wait(500);
    job.kill();
    const code = await job.exit;
    expect(code).not.toBe(0); // killed
  });
});

describe('spawnInJob.kill on Windows', () => {
  it.skipIf(process.platform !== 'win32')('calls taskkill /T /F with the child pid', async () => {
    vi.mocked(execFileMock).mockClear();
    const job = spawnInJob('cmd', ['/c', 'pause']);
    await new Promise((r) => setTimeout(r, 100));
    job.kill();
    await new Promise((r) => setTimeout(r, 500));
    expect(vi.mocked(execFileMock)).toHaveBeenCalledWith(
      'taskkill',
      expect.arrayContaining(['/PID', String(job.pid), '/T', '/F']),
      expect.any(Object),
      expect.any(Function),
    );
    await job.exit;
  });
});
