// auth-token.ts — ADR-0010 scheduled-auth path (the cause-fix for auth-failure
// DETECTION shipped in PR #31).
//
// The print-mode OAuth-non-refresh behaviour means a token-less UNATTENDED weekend
// drain can hit a mid-window 401 (the live Spike-A re-validation is tracked-pending).
// `claude setup-token` mints a **1-year, subscription-auth, inference-only** OAuth
// token — it is NOT an API key (verified live 2026-06-23, code.claude.com/docs/en/
// authentication), so it does not violate the load-bearing "subscription auth, no API
// key" constraint. glean stores it `0600` and injects `CLAUDE_CODE_OAUTH_TOKEN` into
// the spawned `claude` env **only on `--drain` runs**, stripping any override vars so
// the subscription OAuth token wins over a stray API key.
//
// INVARIANT: glean must NEVER pass `claude --bare` — `--bare` ignores
// `CLAUDE_CODE_OAUTH_TOKEN` (asserted in spawn-claude.test.ts on buildClaudeArgs).

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Env vars that OVERRIDE the subscription OAuth token (claude auth precedence:
// API_KEY > AUTH_TOKEN > cloud-provider redirects > OAUTH_TOKEN > /login creds).
// Stripped on the drain spawn so the OAuth token (subscription) is used — never a
// stray API key (the no-API-key constraint) or a cloud-provider redirect.
const OVERRIDE_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

export function authTokenPath(gleanRoot: string): string {
  return join(gleanRoot, 'state', 'auth-token');
}

// A `setup-token` OAuth token is NOT an API key. Reject `sk-…` (an API key — the
// no-API-key constraint), empties, and whitespace-bearing values.
export function validateToken(raw: string): { ok: true; token: string } | { ok: false; reason: string } {
  const token = raw.trim();
  if (!token) return { ok: false, reason: 'empty token' };
  if (/^sk-/i.test(token)) {
    return { ok: false, reason: 'that looks like an API key (sk-…) — glean is subscription-auth only; paste the token from `claude setup-token`' };
  }
  if (/\s/.test(token)) return { ok: false, reason: 'token contains whitespace' };
  return { ok: true, token };
}

// Persist the token at ~/glean/state/auth-token, owner-read/write only.
export function storeToken(gleanRoot: string, token: string): string {
  const p = authTokenPath(gleanRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, token + '\n', { mode: 0o600 });
  // 0o600 is enforced on POSIX; on Windows the mode is a no-op but the whole
  // ~/glean tree already lives under the user profile (user-scoped ACLs). Best-effort.
  try { chmodSync(p, 0o600); } catch { /* Windows ACLs / unsupported — ignore */ }
  return p;
}

export function clearToken(gleanRoot: string): boolean {
  const p = authTokenPath(gleanRoot);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

// The token glean will inject on a drain: the 0600 store first, else an ambient
// CLAUDE_CODE_OAUTH_TOKEN. Returns { token, source } or null.
export function loadAuthToken(
  gleanRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): { token: string; source: 'store' | 'env' } | null {
  const p = authTokenPath(gleanRoot);
  if (existsSync(p)) {
    try {
      const v = readFileSync(p, 'utf8').trim();
      if (v) return { token: v, source: 'store' };
    } catch { /* unreadable store — fall through to env */ }
  }
  const fromEnv = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  return null;
}

// Inject the OAuth token into a spawn env + strip the override vars. **No-op (returns
// the SAME env reference) when token is null** — so the non-drain / no-token path is
// byte-identical. Returns a NEW object only when it changes something.
export function applyScheduledAuthEnv(env: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv {
  if (!token) return env;
  const next: NodeJS.ProcessEnv = { ...env, CLAUDE_CODE_OAUTH_TOKEN: token };
  for (const v of OVERRIDE_VARS) delete next[v];
  return next;
}
