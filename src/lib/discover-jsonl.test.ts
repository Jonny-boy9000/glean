import { describe, it, expect } from 'vitest';
import { discoverJsonl, dashEncode } from './discover-jsonl.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'sessions');
const MULTI_SIGNAL_FIXTURE_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'sessions-multi-signal');

describe('dashEncode', () => {
  it('encodes Windows paths', () => {
    expect(dashEncode('C:\\Glean')).toBe('C--Glean');
  });
  it('encodes POSIX paths', () => {
    expect(dashEncode('/home/user/repo')).toBe('-home-user-repo');
  });
});

describe('discoverJsonl', () => {
  it('emits candidate from session with TODO-like aiTitle', async () => {
    const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: FIXTURE_DIR });
    expect(direct.length).toBe(1);
    expect(direct[0].type).toBe('research-dossier');
    expect((direct[0].evidence as any).kind).toBe('jsonl');
    expect((direct[0].evidence as any).ai_title).toContain('TODO');
  });

  it('returns empty when no sessions match the project', async () => {
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: '/does-not-exist' });
    expect(cands).toEqual([]);
  });

  it('emits candidate from unfinished tool_use signal', async () => {
    const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: MULTI_SIGNAL_FIXTURE_DIR });
    const found = direct.find((c) => (c.evidence as { signal?: string }).signal?.includes('unfinished-tool-use'));
    expect(found).toBeDefined();
    expect((found!.evidence as { signal?: string }).signal).toBe('unfinished-tool-use');
  });

  it('emits candidate from idle-with-content signal (>24h + >10 assistant turns)', async () => {
    const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: MULTI_SIGNAL_FIXTURE_DIR });
    const onlyIdle = direct.find((c) => (c.evidence as { signal?: string }).signal === 'idle-with-content');
    expect(onlyIdle).toBeDefined();
  });

  it('records multiple signals when multiple fire (todo-title + idle-with-content)', async () => {
    const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: MULTI_SIGNAL_FIXTURE_DIR });
    const found = direct.find((c) => {
      const s = (c.evidence as { signal?: string }).signal;
      return s?.includes('todo-title') && s?.includes('idle-with-content');
    });
    expect(found).toBeDefined();
  });
});
