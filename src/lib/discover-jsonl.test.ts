import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { discoverJsonl, dashEncode } from './discover-jsonl.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

// Verified live 2026-06-12 (run 2026-06-12-2109-f8628b): real Claude Code sessions
// under ~/.claude/projects/C--ClaudeCode-Work/ carry NO `ai-title` entry and NO
// `summary` entry at all — their only title-ish fields are `last-prompt` entries
// ({"type":"last-prompt","lastPrompt":"..."}) and the user messages themselves
// ({"type":"user","message":{"role":"user","content":"..."}} — content NESTED in
// `message`, unlike the legacy fixtures' top-level `content`). The old extractor
// only read `ai-title`, so every candidate got ai_title '' → all dossiers slugged
// to `research-` → each task silently overwrote the previous one's OUT.md.
// A candidate must NEVER carry an empty ai_title.
describe('discoverJsonl title extraction (2026-06-12 empty-title data loss)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'glean-title-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSessionFile(fileName: string, lines: object[]): void {
    writeFileSync(join(dir, fileName), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  // ≥11 old assistant turns so the idle-with-content signal fires without a title.
  const assistantTurns = (n: number): object[] =>
    Array.from({ length: n }, (_, i) => ({
      type: 'assistant',
      timestamp: `2026-04-01T10:${String(i).padStart(2, '0')}:00Z`,
      message: { content: [{ type: 'text', text: `turn ${i}` }] },
    }));

  // Sanitized minimal copy of the real 00c1fc60 session's relevant line shapes.
  const realShapedSession = (): object[] => [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-06-08T14:21:58.189Z', sessionId: '00c1fc60', content: 'read this file' },
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-06-08T14:21:58.861Z', sessionId: '00c1fc60' },
    { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: '@"C:\\Users\\user\\Downloads\\basic-memory-parallel-test.md"\nread this file. and write if you understand it.' }, uuid: '25732813', timestamp: '2026-06-08T14:22:00Z' },
    ...assistantTurns(11),
    { type: 'last-prompt', lastPrompt: '@"C:\\Users\\user\\Downloads\\basic-memory-parallel-test.md" read this file. and write if you understand it.', leafUuid: 'd1fe3fa1', sessionId: '00c1fc60' },
    { type: 'user', message: { role: 'user', content: 'Execute basic-memory-parallel-test.md, pausing at the checkpoints' }, uuid: '85f465b2', timestamp: '2026-06-08T14:24:17.702Z' },
    { type: 'last-prompt', lastPrompt: 'Execute basic-memory-parallel-test.md, pausing at the checkpoints', leafUuid: 'e532b2de', sessionId: '00c1fc60' },
  ];

  it('extracts the most recent last-prompt as the title (real session shape, previously yielded "")', async () => {
    writeSessionFile('00c1fc60-4b75-4450-be61-27d4b546e577.jsonl', realShapedSession());
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(1);
    const ev = cands[0].evidence as { ai_title: string };
    expect(ev.ai_title).toBe('Execute basic-memory-parallel-test.md, pausing at the checkpoints');
  });

  it('an explicit non-empty ai-title still wins over last-prompt', async () => {
    writeSessionFile('sess-explicit.jsonl', [
      ...realShapedSession(),
      { type: 'ai-title', sessionId: 'sess-explicit', aiTitle: 'Parallel memory test run' },
    ]);
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(1);
    expect((cands[0].evidence as { ai_title: string }).ai_title).toBe('Parallel memory test run');
  });

  it('a BLANK ai-title entry does not shadow the last-prompt fallback', async () => {
    writeSessionFile('sess-blank-aititle.jsonl', [
      ...realShapedSession(),
      { type: 'ai-title', sessionId: 'sess-blank-aititle', aiTitle: '' },
    ]);
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(1);
    expect((cands[0].evidence as { ai_title: string }).ai_title)
      .toBe('Execute basic-memory-parallel-test.md, pausing at the checkpoints');
  });

  it('falls back to the first user-message text (nested message.content) when no last-prompt exists', async () => {
    writeSessionFile('sess-user-only.jsonl', [
      { type: 'mode', mode: 'normal' },
      { type: 'user', message: { role: 'user', content: 'investigate the flaky scheduler test\nand report back' } },
      ...assistantTurns(11),
    ]);
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(1);
    // Whitespace is collapsed so the title is a single readable line.
    expect((cands[0].evidence as { ai_title: string }).ai_title)
      .toBe('investigate the flaky scheduler test and report back');
  });

  it('skips tool_result-only user lines when deriving the first-user-message title', async () => {
    writeSessionFile('sess-toolresult.jsonl', [
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'file contents' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'now refactor the config loader' }] } },
      ...assistantTurns(11),
    ]);
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(1);
    expect((cands[0].evidence as { ai_title: string }).ai_title).toBe('now refactor the config loader');
  });

  it('falls back to a deterministic "session <first-8-of-session-id>" title for a truly titleless session', async () => {
    writeSessionFile('0f0d81db-4ba4-4fcf-bb4d-21c4518c2350.jsonl', [
      { type: 'mode', mode: 'normal' },
      ...assistantTurns(11),
    ]);
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(1);
    expect((cands[0].evidence as { ai_title: string }).ai_title).toBe('session 0f0d81db');
  });

  it('caps a very long derived title at 80 chars', async () => {
    writeSessionFile('sess-long.jsonl', [
      { type: 'last-prompt', lastPrompt: 'x'.repeat(500), leafUuid: 'l', sessionId: 'sess-long' },
      ...assistantTurns(11),
    ]);
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(1);
    const t = (cands[0].evidence as { ai_title: string }).ai_title;
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.length).toBeGreaterThan(0);
  });

  it('never emits a candidate with an empty ai_title', async () => {
    writeSessionFile('a-real-shaped.jsonl', realShapedSession());
    writeSessionFile('b-titleless.jsonl', [...assistantTurns(11)]);
    const cands = await discoverJsonl('C:\\fake-project', { sessionsDir: dir });
    expect(cands.length).toBe(2);
    for (const c of cands) {
      expect(((c.evidence as { ai_title: string }).ai_title ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});

// Verified live 2026-06-12 (run 2026-06-12-1748-2e70ee): Claude Code's slug encoding
// munges EVERY non-path-separator special char to '-' too (e.g. '_' → '-'), so
// `C:\ClaudeCode_Work` lives at `~/.claude/projects/C--ClaudeCode-Work/`, while
// glean's dashEncode keeps the underscore. History dirs must therefore be resolved
// by the `"cwd"` field inside the session .jsonl lines, not by slug computation.
describe('discoverJsonl cwd-based history dir resolution', () => {
  const PROJ = process.platform === 'win32' ? 'C:\\ClaudeCode_Work' : '/home/user/ClaudeCode_Work';
  const OTHER = process.platform === 'win32' ? 'C:\\Other_Project' : '/home/user/Other_Project';
  // How Claude Code actually encodes it (underscore munged to dash):
  const CLAUDE_SLUG = dashEncode(PROJ).replace(/_/g, '-');
  // glean's naive encoding (underscore preserved):
  const NAIVE_SLUG = dashEncode(PROJ);

  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'glean-jsonl-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(dirName: string, fileName: string, lines: object[], mtime?: Date): void {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, fileName);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (mtime) utimesSync(p, mtime, mtime);
  }

  const todoSession = (cwd: string | null, title = 'TODO: finish the thing'): object[] => [
    // Real sessions start with lines that carry no cwd (mode/queue-operation).
    { type: 'mode', mode: 'normal' },
    ...(cwd === null
      ? [{ type: 'user', timestamp: '2026-05-20T10:00:00Z', content: 'hi' }]
      : [{ type: 'user', timestamp: '2026-05-20T10:00:00Z', cwd, content: 'hi' }]),
    { type: 'ai-title', aiTitle: title },
  ];

  it('(a) finds sessions when Claude\'s slug differs from the naive encoding (underscore case)', async () => {
    expect(CLAUDE_SLUG).not.toBe(NAIVE_SLUG); // the bug precondition
    writeSession(CLAUDE_SLUG, 'sess-a.jsonl', todoSession(PROJ));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    expect(cands.length).toBe(1);
    expect((cands[0].evidence as { session_id: string }).session_id).toBe('sess-a');
  });

  it('(b) falls back to older jsonl files when the newest one has no cwd', async () => {
    writeSession(CLAUDE_SLUG, 'older.jsonl', todoSession(PROJ), new Date('2026-06-01T00:00:00Z'));
    writeSession(CLAUDE_SLUG, 'newest.jsonl', todoSession(null), new Date('2026-06-10T00:00:00Z'));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    expect(cands.length).toBeGreaterThanOrEqual(1);
    const ids = cands.map((c) => (c.evidence as { session_id: string }).session_id);
    expect(ids).toContain('older');
  });

  it('(c) unions sessions from multiple history dirs that resolve to the same cwd', async () => {
    writeSession(CLAUDE_SLUG, 'sess-one.jsonl', todoSession(PROJ));
    writeSession(CLAUDE_SLUG + '-saltmp', 'sess-two.jsonl', todoSession(PROJ, 'TODO: other thing'));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    const ids = cands.map((c) => (c.evidence as { session_id: string }).session_id).sort();
    expect(ids).toEqual(['sess-one', 'sess-two']);
  });

  it('(d) silently skips history dirs with no cwd anywhere', async () => {
    writeSession('some-unrelated-dir', 'no-cwd.jsonl', todoSession(null));
    writeSession(CLAUDE_SLUG, 'sess-a.jsonl', todoSession(PROJ));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    const ids = cands.map((c) => (c.evidence as { session_id: string }).session_id);
    expect(ids).toEqual(['sess-a']);
  });

  it('(d2) returns empty (no throw) when only a cwd-less dir exists', async () => {
    writeSession('some-unrelated-dir', 'no-cwd.jsonl', todoSession(null));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    expect(cands).toEqual([]);
  });

  it('(e) original happy path: naive-slug dir with matching cwd still works, counted once', async () => {
    writeSession(NAIVE_SLUG, 'sess-naive.jsonl', todoSession(PROJ));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    const ids = cands.map((c) => (c.evidence as { session_id: string }).session_id);
    expect(ids).toEqual(['sess-naive']);
  });

  it('(e2) naive-slug dir whose sessions carry no cwd is still trusted (compat fast path)', async () => {
    writeSession(NAIVE_SLUG, 'sess-naive.jsonl', todoSession(null));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    const ids = cands.map((c) => (c.evidence as { session_id: string }).session_id);
    expect(ids).toEqual(['sess-naive']);
  });

  it('does not match dirs whose newest cwd points at a different project', async () => {
    // Newest file claims OTHER; per-dir cwd is the first hit newest-first.
    writeSession('ambiguous-dir', 'older.jsonl', todoSession(PROJ), new Date('2026-06-01T00:00:00Z'));
    writeSession('ambiguous-dir', 'newest.jsonl', todoSession(OTHER), new Date('2026-06-10T00:00:00Z'));
    const cands = await discoverJsonl(PROJ, { projectsRoot: root });
    expect(cands).toEqual([]);
  });

  (process.platform === 'win32' ? it : it.skip)(
    'matches cwd case-insensitively on win32',
    async () => {
      writeSession(CLAUDE_SLUG, 'sess-a.jsonl', todoSession(PROJ));
      const cands = await discoverJsonl(PROJ.toLowerCase(), { projectsRoot: root });
      expect(cands.length).toBe(1);
    },
  );
});
