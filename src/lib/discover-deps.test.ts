import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDeps } from './discover-deps.js';

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'glean-deps-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email t@t', { cwd: repo });
  execSync('git config user.name t', { cwd: repo });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ dependencies: { lodash: '^4.0.0' } }, null, 2),
  );
  execSync('git add . && git commit -q -m init', { cwd: repo });
  // Add a new dep in a follow-up commit
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ dependencies: { lodash: '^4.0.0', zod: '^3.22.0' } }, null, 2),
  );
  execSync('git add . && git commit -q -m "add zod"', { cwd: repo });
});

describe('discoverDeps', () => {
  it('emits one candidate per recently-added package.json entry', async () => {
    const cands = await discoverDeps(repo);
    const packages = cands.map((c) => (c.evidence as any).package);
    expect(packages).toContain('zod');
    expect(packages).not.toContain('lodash'); // present at init, not newly added
  });

  it('emits candidates from a manifest that was ADDED in the last 14 days (not modified)', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-deps-new-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t', { cwd: r });
    execSync('git config user.name t', { cwd: r });
    writeFileSync(join(r, 'README.md'), 'x');
    execSync('git add . && git commit -q -m init', { cwd: r });
    writeFileSync(join(r, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.0.0' } }, null, 2));
    execSync('git add . && git commit -q -m "add package.json"', { cwd: r });

    const cands = await discoverDeps(r);
    const packages = cands.map(c => (c.evidence as { package: string }).package);
    expect(packages).toContain('lodash');
  });

  it('package.json: ignores top-level fields like name/description/scripts', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-deps-scope-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t && git config user.name t', { cwd: r });
    writeFileSync(join(r, 'README.md'), 'x');
    execSync('git add . && git commit -q -m init', { cwd: r });
    writeFileSync(join(r, 'package.json'), JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      description: 'A demo app',
      scripts: { build: 'tsc', test: 'vitest' },
      bin: { mycli: './bin/cli.js' },
      dependencies: { lodash: '^4.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2));
    execSync('git add . && git commit -q -m "add manifest"', { cwd: r });

    const cands = await discoverDeps(r);
    const packages = cands.map((c) => (c.evidence as { package: string }).package);
    expect(packages).toContain('lodash');
    expect(packages).toContain('typescript');
    expect(packages).not.toContain('name');
    expect(packages).not.toContain('version');
    expect(packages).not.toContain('description');
    expect(packages).not.toContain('scripts');
    expect(packages).not.toContain('bin');
    expect(packages).not.toContain('build');
    expect(packages).not.toContain('test');
    expect(packages).not.toContain('mycli');
  });

  it('Cargo.toml: ignores [package] table, captures [dependencies] and [dev-dependencies]', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-deps-cargo-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t && git config user.name t', { cwd: r });
    writeFileSync(join(r, 'README.md'), 'x');
    execSync('git add . && git commit -q -m init', { cwd: r });
    writeFileSync(join(r, 'Cargo.toml'), `[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
mockito = "1.0"
`);
    execSync('git add . && git commit -q -m "add Cargo.toml"', { cwd: r });

    const cands = await discoverDeps(r);
    const packages = cands.map((c) => (c.evidence as { package: string }).package);
    expect(packages).toContain('serde');
    expect(packages).toContain('tokio');
    expect(packages).toContain('mockito');
    expect(packages).not.toContain('name');
    expect(packages).not.toContain('version');
    expect(packages).not.toContain('edition');
  });

  it('pyproject.toml: ignores [build-system] and top-level project fields, captures dependencies', async () => {
    const r = mkdtempSync(join(tmpdir(), 'glean-deps-py-'));
    execSync('git init -q', { cwd: r });
    execSync('git config user.email t@t && git config user.name t', { cwd: r });
    writeFileSync(join(r, 'README.md'), 'x');
    execSync('git add . && git commit -q -m init', { cwd: r });
    writeFileSync(join(r, 'pyproject.toml'), `[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[project]
name = "my-pkg"
version = "0.1.0"
description = "demo"
dependencies = [
  "requests>=2.28",
  "click>=8.0",
]

[project.optional-dependencies]
dev = ["pytest>=7", "black"]

[tool.ruff]
line-length = 100
`);
    execSync('git add . && git commit -q -m "add pyproject"', { cwd: r });

    const cands = await discoverDeps(r);
    const packages = cands.map((c) => (c.evidence as { package: string }).package);
    expect(packages).toContain('requests');
    expect(packages).toContain('click');
    expect(packages).toContain('pytest');
    expect(packages).toContain('black');
    expect(packages).not.toContain('name');
    expect(packages).not.toContain('version');
    expect(packages).not.toContain('description');
    expect(packages).not.toContain('setuptools');
    expect(packages).not.toContain('line-length');
    expect(packages).not.toContain('build-backend');
    expect(packages).not.toContain('requires');
  });
});
