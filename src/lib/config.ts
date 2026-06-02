import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import type { GleanConfig } from './types.js';

const Schema = z.object({
  claude_bin: z.string().optional(),
  projects: z.record(z.string(), z.object({
    base_branch: z.string().optional(),
    test_command: z.string().optional(),
  })).optional(),
  drain_trigger: z.object({
    day: z.string().optional(),
    time: z.string().optional(),
    repeat_minutes: z.number().optional(),
    duration_hours: z.number().optional(),
    // v0.8.2 item 1: configurable circuit-breaker threshold (was the hard-coded
    // MAX_UNPRODUCTIVE = 3). Optional — defaults to 3 in runDrain when unset.
    // Integer: it's compared against the whole-number unproductive_reentries
    // counter, so a fractional value (e.g. 3.7) would never trip the guard.
    max_unproductive: z.number().int().optional(),
    // v0.8.2 item 3: anti-spill pre-emptive margin in minutes (whole minutes).
    // Optional — defaults to 15 in runDrain when unset.
    anti_spill_margin_minutes: z.number().int().optional(),
  }).optional(),
});

export function loadConfig(path: string): GleanConfig {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`config: cannot read ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config: invalid JSON in ${path}: ${(e as Error).message}`);
  }
  const result = Schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`config: schema violation at ${issue.path.join('.')}: ${issue.message}`);
  }
  return result.data;
}

export function defaultConfigPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return `${home}\\glean\\config.json`;
}
