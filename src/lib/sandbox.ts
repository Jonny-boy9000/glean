// sandbox.ts — OS-sandbox enforcement for spawned `claude -p` sessions (ADR-0013,
// supersedes the deferred sandbox leg of ADR-0009).
//
// The Narrow default (ADR-0009) makes in-session subprocess writes defense-in-depth
// only — on EVERY platform. This module adds the opt-in `enforce_spawn` posture
// that turns them into a HARD OS filesystem boundary WHERE THE PLATFORM SUPPORTS
// ONE: macOS (Seatbelt) + Linux/WSL2 (bubblewrap). **Native Windows has no OS
// sandbox**, so on Windows `enforce_spawn` falls back to Narrow (with a loud
// warning) and `strict_spawn` stays the only hard guarantee there.
//
// Verified live 2026-06-23 against code.claude.com/docs/sandboxing + /cli-reference:
//   - `--settings '<json>'` accepts an inline JSON string and overrides settings
//     keys FOR THAT SESSION ONLY — zero mutation of the user's ~/.claude/settings.json.
//   - keys: sandbox.enabled / .failIfUnavailable / .allowUnsandboxedCommands +
//     sandbox.filesystem.{allowWrite,denyRead,allowRead}; path prefixes / (abs),
//     ~/ (home), ./ (cwd/project-relative). Default write scope is cwd + $TMPDIR.
//   - the sandbox AUTO-allows a linked worktree's shared .git (refs/index) but keeps
//     .git/hooks + .git/config DENIED — complements glean's hook-neuter exactly.
//   - failIfUnavailable:true makes the spawn FAIL CLOSED (refuse) if bwrap/socat is
//     missing, rather than silently running unsandboxed (the safety hinge).

import { execFileSync } from 'node:child_process';

export type SandboxPlatform = 'darwin' | 'linux' | 'win32' | 'other';
export type SandboxAvailability = { available: boolean; platform: SandboxPlatform; missing: string[] };
export type SpawnPosture = 'strict' | 'enforce' | 'narrow';

// Secret stores a sandboxed in-session subprocess must never read (exfil guard).
// `~/` resolves to the spawn user's home; the sandbox is mac/Linux/WSL2 only, so
// `~/` semantics always apply. Default read policy is broad, so denying these is
// what actually protects them.
export const SECRET_DENY_READ = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.npmrc',
  '~/.git-credentials',
  '~/.netrc',
  '~/.claude/.credentials.json',
] as const;

// Injectable PATH probe (test seam). True iff `prog` resolves on PATH.
function onPath(prog: string): boolean {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(finder, [prog], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
  } catch {
    return false;
  }
}

// Whether the OS sandbox can run on this platform. `failIfUnavailable:true` is the
// real safety net (the spawn refuses if the runtime is actually missing), so this
// detection only decides whether to ATTEMPT enforcement: darwin always (Seatbelt is
// built in); linux/WSL2 (process.platform==='linux' under WSL2) iff bwrap+socat are
// on PATH; native Windows never. Pure given the injected probe — unit-testable.
export function detectSandboxAvailability(
  platform: NodeJS.Platform = process.platform,
  probe: (p: string) => boolean = onPath,
): SandboxAvailability {
  if (platform === 'darwin') return { available: true, platform: 'darwin', missing: [] };
  if (platform === 'linux') {
    const missing: string[] = [];
    if (!probe('bwrap')) missing.push('bubblewrap (bwrap)');
    if (!probe('socat')) missing.push('socat');
    return { available: missing.length === 0, platform: 'linux', missing };
  }
  if (platform === 'win32') {
    return { available: false, platform: 'win32', missing: ['the OS sandbox is not supported on native Windows (run under WSL2 for a hard boundary)'] };
  }
  return { available: false, platform: 'other', missing: ['unsupported platform for the OS sandbox'] };
}

// Resolve the effective spawn posture. Most-restrictive-wins: strict_spawn (no
// in-session code at all — platform-independent hard guarantee) beats enforce_spawn
// (OS-sandboxed in-session code) beats Narrow (defense-in-depth). enforce_spawn on a
// platform WITHOUT a sandbox degrades to Narrow and flags it, so the caller can warn
// loudly (never a silent unsandboxed run).
export function resolveSpawnPosture(
  cfg: { strict_spawn?: boolean; enforce_spawn?: boolean },
  availability: SandboxAvailability,
): { posture: SpawnPosture; enforceRequestedButUnavailable: boolean } {
  if (cfg.strict_spawn) return { posture: 'strict', enforceRequestedButUnavailable: false };
  if (cfg.enforce_spawn) {
    if (availability.available) return { posture: 'enforce', enforceRequestedButUnavailable: false };
    return { posture: 'narrow', enforceRequestedButUnavailable: true };
  }
  return { posture: 'narrow', enforceRequestedButUnavailable: false };
}

// Build the inline `--settings` JSON that confines a spawn to `writeRoot` (its cwd —
// the worktree or dossier dir) and denies reading secret stores. Object key order is
// fixed so the string is STABLE (regression-tested like draftImplAllowedTools).
//   - readScopes: extra read-allow paths (e.g. a research-dossier's project_path,
//     re-allowed even when it sits under a denyRead region).
//   - denyReadExtra: extra deny paths (e.g. the user's MAIN checkout for draft-impl,
//     so the spawn can't peek at uncommitted work outside its worktree).
export function buildSandboxSettings(opts: {
  writeRoot: string;
  readScopes?: string[];
  denyReadExtra?: string[];
}): string {
  const filesystem: { allowWrite: string[]; denyRead: string[]; allowRead?: string[] } = {
    allowWrite: [opts.writeRoot],
    denyRead: [...SECRET_DENY_READ, ...(opts.denyReadExtra ?? [])],
  };
  if (opts.readScopes && opts.readScopes.length) filesystem.allowRead = [...opts.readScopes];
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem,
    },
  });
}
