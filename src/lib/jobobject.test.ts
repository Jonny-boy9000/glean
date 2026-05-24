import { describe, it, expect } from 'vitest';
import { spawnInJob } from './jobobject.js';
import { setTimeout as wait } from 'node:timers/promises';

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
