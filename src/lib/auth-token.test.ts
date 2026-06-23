import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateToken,
  storeToken,
  clearToken,
  loadAuthToken,
  applyScheduledAuthEnv,
  authTokenPath,
} from './auth-token.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'glean-auth-'));
}

describe('validateToken (ADR-0010)', () => {
  it('accepts a normal setup-token value', () => {
    const r = validateToken('  sk_ant_oat01_abc123  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe('sk_ant_oat01_abc123');
  });

  it('REJECTS an API key (sk-…) — glean is subscription-auth only', () => {
    const r = validateToken('sk-ant-api03-secret');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/API key/i);
  });

  it('rejects empty / whitespace-bearing tokens', () => {
    expect(validateToken('   ').ok).toBe(false);
    expect(validateToken('two words').ok).toBe(false);
  });
});

describe('store / load / clear token round-trip', () => {
  it('stores at ~/glean/state/auth-token and reads it back', () => {
    const root = tmpRoot();
    const p = storeToken(root, 'tok-123');
    expect(p).toBe(authTokenPath(root));
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8').trim()).toBe('tok-123');
    const loaded = loadAuthToken(root, {});
    expect(loaded).toEqual({ token: 'tok-123', source: 'store' });
  });

  it('falls back to ambient CLAUDE_CODE_OAUTH_TOKEN when no store exists', () => {
    const root = tmpRoot();
    expect(loadAuthToken(root, {})).toBeNull();
    expect(loadAuthToken(root, { CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' })).toEqual({ token: 'env-tok', source: 'env' });
  });

  it('the store wins over the env', () => {
    const root = tmpRoot();
    storeToken(root, 'store-tok');
    expect(loadAuthToken(root, { CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' })).toEqual({ token: 'store-tok', source: 'store' });
  });

  it('clear removes the store (idempotent)', () => {
    const root = tmpRoot();
    storeToken(root, 'tok');
    expect(clearToken(root)).toBe(true);
    expect(existsSync(authTokenPath(root))).toBe(false);
    expect(clearToken(root)).toBe(false);
  });
});

describe('applyScheduledAuthEnv (drain env injection)', () => {
  it('sets CLAUDE_CODE_OAUTH_TOKEN and STRIPS override vars (API key etc.)', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-api03-leak',
      ANTHROPIC_AUTH_TOKEN: 'other',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
    };
    const out = applyScheduledAuthEnv(env, 'oauth-tok');
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin'); // unrelated vars preserved
    // Pure: original env untouched.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-leak');
  });

  it('is a NO-OP (same reference) when token is null — bare path byte-identical', () => {
    const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'keep' };
    expect(applyScheduledAuthEnv(env, null)).toBe(env);
  });
});
