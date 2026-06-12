import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from './state.js';
import type { GleanConfig, ProjectPriority } from './types.js';

// v0.9 model routing (ADR-0006): maps are keyed STRICTLY by the known task
// types — a typo'd / unknown type key is a schema error, not a silent no-op.
const TASK_TYPES = ['fetch-docs', 'research-dossier', 'draft-impl'] as const;
const TaskTypeKey = z.enum(TASK_TYPES);

const Schema = z.object({
  claude_bin: z.string().optional(),
  // v0.9 model routing: per-task-type model (alias like 'sonnet' or a full
  // model id — accepted verbatim). Partial: unlisted types use the built-in
  // defaults at resolution time (model-routing.ts).
  // (z.record with an enum key validates each present key but does not require
  // exhaustiveness at runtime — exactly the partial-map behavior we want.)
  models: z.record(TaskTypeKey, z.string()).optional(),
  // v0.9: per-task-type --max-turns runaway-loop guard. Whole positive turns.
  max_turns: z.record(TaskTypeKey, z.number().int().positive()).optional(),
  // v0.9: task types eligible for the 'large' pace-tier one-tier promotion.
  // Absent → ['draft-impl'] at resolution time ("route up" is never blanket).
  pacing_promote: z.array(TaskTypeKey).optional(),
  projects: z.record(z.string(), z.object({
    base_branch: z.string().optional(),
    test_command: z.string().optional(),
    // v0.9 project portfolio: per-project priority dial. Absent = 'normal' for
    // a configured project (backward compatible); merely-discovered projects
    // are implicitly 'off' (discovery must never authorize spending capacity).
    priority: z.enum(['off', 'low', 'normal', 'high']).optional(),
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

export const PROJECT_PRIORITIES: readonly ProjectPriority[] = ['off', 'low', 'normal', 'high'];

export function isProjectPriority(v: unknown): v is ProjectPriority {
  return typeof v === 'string' && (PROJECT_PRIORITIES as readonly string[]).includes(v);
}

/**
 * Effective priority dial for a project: configured projects default to
 * 'normal' when the dial is absent; an UNCONFIGURED project is always 'off' —
 * discovery alone must never authorize spending capacity on a repo.
 */
export function effectivePriority(cfg: GleanConfig, projectPath: string): ProjectPriority {
  const entry = cfg.projects?.[projectPath];
  if (!entry) return 'off';
  return entry.priority ?? 'normal';
}

/**
 * Set (or opt-in create) a project's priority dial in config.json.
 * - Adds the project entry when missing (= the explicit opt-in gesture).
 * - 'off' KEEPS the entry — other fields (base_branch, test_command) survive.
 * - Atomic write; a corrupt existing config is never overwritten.
 */
export function setProjectPriority(
  configPath: string,
  projectPath: string,
  priority: string,
): { ok: boolean; created?: boolean; reason?: string } {
  if (!isProjectPriority(priority)) {
    return { ok: false, reason: `invalid priority '${priority}' — use one of: ${PROJECT_PRIORITIES.join(', ')}` };
  }
  // Edit the RAW JSON (not the zod-parsed result) so unknown/extra fields a
  // user added by hand are preserved verbatim.
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, reason: `config: invalid JSON in ${configPath}: ${(e as Error).message}` };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: `config: ${configPath} is not a JSON object` };
    }
  }
  const projects = (raw.projects ?? {}) as Record<string, Record<string, unknown>>;
  const created = !(projectPath in projects);
  projects[projectPath] = { ...projects[projectPath], priority };
  raw.projects = projects;
  try {
    atomicWriteFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  return { ok: true, created };
}

export function defaultConfigPath(): string {
  // join (not a hard-coded `\`) — this must resolve to ~/glean/config.json on
  // POSIX too; same output as before on Windows.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return join(home, 'glean', 'config.json');
}
