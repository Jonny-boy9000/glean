import { describe, it, expect } from 'vitest';
import { buildClaudeArgs } from './spawn-claude.js';

const BASE = {
  model: 'sonnet',
  maxTurns: 24,
  addDirs: ['/work/wt'],
  deny: 'Bash(git push:*) Bash(git checkout main:*)',
  sessionId: '00000000-0000-0000-0000-000000000001',
};

describe('buildClaudeArgs (ADR-0013 / ADR-0009 argv invariants)', () => {
  it('ALWAYS appends the deny-list as --disallowedTools (INVARIANT[ADR-0009])', () => {
    const argv = buildClaudeArgs(BASE);
    const i = argv.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe(BASE.deny);
  });

  it('omits --settings / --setting-sources when no sandbox settings are supplied', () => {
    const argv = buildClaudeArgs(BASE);
    expect(argv).not.toContain('--settings');
    expect(argv).not.toContain('--setting-sources');
  });

  it('byte-identical (no --settings) path matches the pre-sandbox shape exactly', () => {
    // The default/Narrow/Windows path must be unchanged by ADR-0013.
    expect(buildClaudeArgs({ ...BASE, allowedTools: 'Edit Write' })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', 'sonnet', '--max-turns', '24', '--add-dir', '/work/wt',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Edit Write',
      '--disallowedTools', BASE.deny,
      '--session-id', BASE.sessionId,
    ]);
  });

  it('injects --settings + --setting-sources user,local when sandbox settings are supplied (enforce_spawn)', () => {
    const settings = '{"sandbox":{"enabled":true}}';
    const argv = buildClaudeArgs({ ...BASE, allowedTools: 'Edit Write', settings });
    const si = argv.indexOf('--settings');
    expect(si).toBeGreaterThanOrEqual(0);
    expect(argv[si + 1]).toBe(settings);
    const ssi = argv.indexOf('--setting-sources');
    expect(argv[ssi + 1]).toBe('user,local');
    // --settings sits AFTER --allowedTools and BEFORE --disallowedTools (so index-based
    // deny/allow assertions in the F2 integration tests are unaffected).
    expect(si).toBeGreaterThan(argv.indexOf('--allowedTools'));
    expect(si).toBeLessThan(argv.indexOf('--disallowedTools'));
  });

  it('omits --allowedTools when not supplied (fetch-docs), still appends the deny-list', () => {
    const argv = buildClaudeArgs(BASE);
    expect(argv).not.toContain('--allowedTools');
    expect(argv).toContain('--disallowedTools');
  });
});
