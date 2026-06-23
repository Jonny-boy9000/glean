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

// Optional: dump the auth-relevant env this stub was spawned with, so a test can
// assert glean's --drain CLAUDE_CODE_OAUTH_TOKEN injection + API-key stripping (ADR-0010).
if (process.env.FAKE_CLAUDE_ENV_OUT) {
  try {
    const e = process.env;
    appendFileSync(process.env.FAKE_CLAUDE_ENV_OUT, JSON.stringify({
      CLAUDE_CODE_OAUTH_TOKEN: e.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY ?? null,
      ANTHROPIC_AUTH_TOKEN: e.ANTHROPIC_AUTH_TOKEN ?? null,
      CLAUDE_CODE_USE_BEDROCK: e.CLAUDE_CODE_USE_BEDROCK ?? null,
    }) + '\n');
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

// Wedged-child simulation (ADR-0004): keep emitting a line on an interval for
// the whole lifetime, holding the stdout pipe open — like the real `claude -p`
// stuck in an api_retry loop on 2026-06-12. Combined with sleep_ms this child
// never finishes "politely" within a test's timeout window.
if (scenario.stdout_interval_ms && scenario.stdout_interval_line) {
  const interval = setInterval(
    () => process.stdout.write(scenario.stdout_interval_line + '\n'),
    scenario.stdout_interval_ms,
  );
  // If our reader vanishes (executor force-resolved and destroyed its pipe
  // end), EPIPE would crash node loudly; exit quietly instead.
  process.stdout.on('error', () => { clearInterval(interval); process.exit(0); });
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
