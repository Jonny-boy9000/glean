import { describe, it, expect } from 'vitest';
import { discoverJsonl, dashEncode } from './discover-jsonl.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'sessions');

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
    const found = direct.find((c) => (c.evidence as any).ai_title?.includes('TODO'));
    expect(found).toBeDefined();
    expect(found!.type).toBe('research-dossier');
    expect((found!.evidence as any).kind).toBe('jsonl');
    expect((found!.evidence as any).ai_title).toContain('TODO');
  });

  it('returns empty when no sessions match the project', async () => {
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: '/does-not-exist' });
    expect(cands).toEqual([]);
  });

  it('emits candidate from unfinished tool_use signal', async () => {
    const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: FIXTURE_DIR });
    const found = direct.find((c) => (c.evidence as { signal?: string }).signal?.includes('unfinished-tool-use'));
    expect(found).toBeDefined();
  });

  it('emits candidate from idle-with-content signal (>24h + >10 assistant turns)', async () => {
    const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: FIXTURE_DIR });
    const found = direct.find((c) => (c.evidence as { signal?: string }).signal?.includes('idle-with-content'));
    expect(found).toBeDefined();
  });

  it('records multiple signals when multiple fire (todo-title + idle-with-content)', async () => {
    const direct = await discoverJsonl('C:\\fake-project', { sessionsDir: FIXTURE_DIR });
    const found = direct.find((c) =>
      (c.evidence as { signal?: string }).signal?.includes('todo-title') &&
      (c.evidence as { signal?: string }).signal?.includes('idle-with-content')
    );
    expect(found).toBeDefined();
  });
});
