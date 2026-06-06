#!/usr/bin/env node
// Pretends to be `claude -p`. Reads scenario YAML pointed to by env var FAKE_CLAUDE_SCENARIO.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { parse } from 'yaml';

// Optional: dump the argv this stub was invoked with so a test can assert on the
// exact --add-dir / --allowedTools / --disallowedTools flags glean constructed.
// One JSON line is appended per invocation (a drain may spawn several tasks).
if (process.env.FAKE_CLAUDE_ARGV_OUT) {
  try {
    appendFileSync(process.env.FAKE_CLAUDE_ARGV_OUT, JSON.stringify(process.argv.slice(2)) + '\n');
  } catch {
    /* best effort */
  }
}

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
if (!scenarioPath) {
  console.error('FAKE_CLAUDE_SCENARIO env var required');
  process.exit(2);
}
const scenario = parse(readFileSync(scenarioPath, 'utf8'));

// Optional output file (used to produce OUT.md without going through claude)
if (scenario.write_out_md) {
  const cwd = process.cwd();
  writeFileSync(`${cwd}/OUT.md`, scenario.write_out_md);
}

// draft-impl simulation: write files into the cwd (the worktree), then run
// shell commands (e.g. git add/commit) — mimics the model editing + committing.
if (Array.isArray(scenario.write_files)) {
  for (const f of scenario.write_files) {
    writeFileSync(join(process.cwd(), f.path), f.content ?? '');
  }
}
if (Array.isArray(scenario.shell_commands)) {
  for (const cmd of scenario.shell_commands) {
    try {
      execSync(cmd, { cwd: process.cwd(), stdio: 'inherit' });
    } catch (e) {
      // Surface but don't abort — some scenarios intentionally run blocked cmds.
      process.stderr.write(`fake-claude: shell command failed: ${cmd}: ${e.message}\n`);
    }
  }
}

// Stream stdout lines (e.g., stream-json fragments) with delays
const stdoutLines = scenario.stdout_lines ?? [];
const stderrLines = scenario.stderr_lines ?? [];
const sleepMs = scenario.sleep_ms ?? 0;
const exitCode = scenario.exit_code ?? 0;

(async () => {
  for (const line of stdoutLines) {
    process.stdout.write(line + '\n');
  }
  for (const line of stderrLines) {
    process.stderr.write(line + '\n');
  }
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  process.exit(exitCode);
})();
