#!/usr/bin/env node
// Pretends to be `claude -p`. Reads scenario YAML pointed to by env var FAKE_CLAUDE_SCENARIO.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

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
