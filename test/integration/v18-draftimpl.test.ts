import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DRAFT_IMPL_DENY, draftImplAllowedTools, DEFAULT_TEST_COMMAND_ALLOW } from '../../src/lib/deny.js';

const FAKE_CLAUDE = process.platform === 'win32'
  ? join(process.cwd(), 'test', 'fixtures', 'fake-claude.cmd')
  : join(process.cwd(), 'test', 'fixtures', 'fake-claude.sh');

function scenario(name: string): string {
  return join(process.cwd(), 'test', 'fixtures', 'scenarios', name);
}

function makeRepo(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), 'glean-v18-'));
  execSync('git init -q -b main', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(join(repo, 'a.ts'), '// TODO: implement the feature\n');
  execSync('git add . && git commit -q -m init', { cwd: repo });
  const head = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  return { repo, head };
}

function makeHome(repoPath: string): string {
  const home = mkdtempSync(join(tmpdir(), 'glean-v18-home-'));
  mkdirSync(join(home, 'glean'), { recursive: true });
  // config keys on the RESOLVED project path (cli.ts resolves args.project).
  writeFileSync(join(home, 'glean', 'config.json'), JSON.stringify({
    claude_bin: FAKE_CLAUDE,
    projects: { [resolve(repoPath)]: { base_branch: 'main' } },
  }));
  return home;
}

function runGlean(repo: string, home: string, scenarioFile: string, argvOut?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    FAKE_CLAUDE_SCENARIO: scenario(scenarioFile),
  };
  if (argvOut) env.FAKE_CLAUDE_ARGV_OUT = argvOut;
  return spawnSync('node', ['bin/glean.js', 'run', '--project', repo, '--budget', '60m'], {
    env,
    encoding: 'utf8',
  });
}

function readIndexEntries(home: string): Array<Record<string, unknown>> {
  const dossiers = join(home, 'glean', 'dossiers');
  const slugs = readdirSync(dossiers);
  for (const slug of slugs) {
    const dateDir = join(dossiers, slug);
    for (const d of readdirSync(dateDir)) {
      const idx = join(dateDir, d, 'INDEX.md');
      if (existsSync(idx)) {
        const m = readFileSync(idx, 'utf8').match(/^---\n([\s\S]+?)\n---/);
        if (m) {
          const fm = parseYaml(m[1]) as { entries?: Array<Record<string, unknown>> };
          if (fm.entries?.length) return fm.entries;
        }
      }
    }
  }
  return [];
}

describe('verification 18: draft-impl end-to-end', () => {
  it('writes a reviewable prep branch off base with main HEAD untouched, scratch excluded', () => {
    const { repo, head } = makeRepo();
    const home = makeHome(repo);

    const res = runGlean(repo, home, 'draft-impl-commit.yaml');
    expect(res.status).toBe(0);

    // a prep branch exists with a commit beyond base
    const prep = execSync('git branch --list "prep/glean-*"', { cwd: repo, encoding: 'utf8' }).trim();
    expect(prep).toMatch(/prep\/glean-/);
    const branchName = prep.replace(/^[*+\s]+/, '');
    const count = execSync(`git rev-list main..${branchName} --count`, { cwd: repo, encoding: 'utf8' }).trim();
    expect(Number(count)).toBeGreaterThanOrEqual(1);

    // worktree created on the configured base
    const wtList = execSync('git worktree list', { cwd: repo, encoding: 'utf8' });
    expect(wtList).toContain(branchName.replace('refs/heads/', ''));

    // main HEAD unchanged
    expect(execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim()).toBe(head);

    // glean prompt.md is NOT in the committed tree
    const tree = execSync(`git ls-tree -r --name-only ${branchName}`, { cwd: repo, encoding: 'utf8' });
    expect(tree).not.toContain('prompt.md');
    expect(tree).toContain('feature.ts');

    // INDEX entry diff stat matches the actual branch diff
    const entries = readIndexEntries(home);
    const branchEntry = entries.find((e) => e.type === 'draft-impl');
    expect(branchEntry).toBeTruthy();
    const numstat = execSync(`git diff --numstat main...${branchName}`, { cwd: repo, encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean);
    let ins = 0, del = 0;
    for (const line of numstat) { const [i, d] = line.split('\t'); ins += Number(i) || 0; del += Number(d) || 0; }
    expect(branchEntry!.files).toBe(numstat.length);
    expect(branchEntry!.insertions).toBe(ins);
    expect(branchEntry!.deletions).toBe(del);
  });

  it('main HEAD stays put even when the draft session attempts git switch main', () => {
    const { repo, head } = makeRepo();
    const home = makeHome(repo);

    const res = runGlean(repo, home, 'draft-impl-switch-main.yaml');
    expect(res.status).toBe(0);

    // the adversarial `git switch main` did not move the main worktree's HEAD
    expect(execSync('git rev-parse main', { cwd: repo, encoding: 'utf8' }).trim()).toBe(head);
    // the commit still landed on the prep branch
    const prep = execSync('git branch --list "prep/glean-*"', { cwd: repo, encoding: 'utf8' }).trim();
    const branchName = prep.replace(/^[*+\s]+/, '');
    const count = execSync(`git rev-list main..${branchName} --count`, { cwd: repo, encoding: 'utf8' }).trim();
    expect(Number(count)).toBeGreaterThanOrEqual(1);
  });

  // F2 safety proof (draft-impl): the spawn argv must carry the FULL draft-impl
  // deny-list AND a SCOPED allow-list (Edit/Write + git commit-cycle + the
  // project test command) — never a bare `Bash`. The deny/allow CONSTANTS are
  // unit-tested in deny.test.ts; this asserts they actually reach `claude -p`,
  // which is the regression guard that makes the executor refactor safe.
  it('draft-impl spawn argv carries DRAFT_IMPL_DENY and the scoped draft-impl allow-list (no bare Bash)', () => {
    const { repo } = makeRepo();
    const home = makeHome(repo);
    const argvOut = join(home, 'argv.jsonl');

    const res = runGlean(repo, home, 'draft-impl-commit.yaml', argvOut);
    expect(res.status).toBe(0);

    expect(existsSync(argvOut)).toBe(true);
    const invocations = readFileSync(argvOut, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as string[]);
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    const argv = invocations[0];

    // --disallowedTools is exactly DRAFT_IMPL_DENY.
    const denyIdx = argv.indexOf('--disallowedTools');
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(argv[denyIdx + 1]).toBe(DRAFT_IMPL_DENY);

    // --allowedTools is exactly draftImplAllowedTools(default test command). The
    // v18 config has no test_command, so the default test-runner prefixes apply
    // (ADR-0009 narrow: npm test / npx vitest — no node / npm run).
    const allowIdx = argv.indexOf('--allowedTools');
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    const allow = argv[allowIdx + 1];
    expect(allow).toBe(draftImplAllowedTools(DEFAULT_TEST_COMMAND_ALLOW));

    // No bare `Bash` token (a wholesale-shell grant that a prefix deny can't fully block).
    const tokens = allow.match(/Bash\([^)]*\)|\S+/g) ?? [];
    expect(tokens).not.toContain('Bash');
  });

  it('recovers from a kill mid-commit (stale index.lock) and still produces a branch', () => {
    const { repo } = makeRepo();
    const home = makeHome(repo);

    const res = runGlean(repo, home, 'draft-impl-lock-leftover.yaml');
    expect(res.status).toBe(0);

    const prep = execSync('git branch --list "prep/glean-*"', { cwd: repo, encoding: 'utf8' }).trim();
    expect(prep).toMatch(/prep\/glean-/);
    const branchName = prep.replace(/^[*+\s]+/, '');
    const tree = execSync(`git ls-tree -r --name-only ${branchName}`, { cwd: repo, encoding: 'utf8' });
    expect(tree).toContain('feature.ts');
  });
});
