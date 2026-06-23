# ADR-0010 — Auth-failure handling (detect + stop loudly) and the scheduled-auth path

- Status: **Accepted** (detection + the `setup-token` scheduled-auth path **BUILT** 2026-06-23; the live **Spike-A re-validation** is **TRACKED-PENDING** — do NOT promote to 're-validated' until a real multi-hour drain captures it)
- Date: 2026-06-23
- Enforced at: `src/lib/classify.ts` (`AUTH_ERROR_RE` + `isStreamAuthErrorLine`, tagged `ASSUMPTION[ADR-0009] UNVERIFIED`),
  `src/lib/spawn-claude.ts` (`SpawnOutcome.authError` + the `AUTH-CAPTURE` tripwire), `src/lib/pipeline.ts`
  (stops the run with `reason: 'auth-error'`, exit 50), `src/lib/render-morning.ts` (the receipt banner).
  Tests: `classify.test.ts` (AUTH detection), `v28-auth-error.test.ts` (exit 50 / reason `auth-error`),
  `render-morning.test.ts` (banner). **Scheduled-auth path:** `src/lib/auth-token.ts` (`loadAuthToken` /
  `applyScheduledAuthEnv` / `storeToken` / `validateToken`), `src/cli.ts` (`glean auth setup-token|status|clear`
  + the `--drain` env injection + the doctor line). Tests: `auth-token.test.ts`, `v31-auth-cli`,
  `v32-drain-auth-env` (the `--drain` token-injection + API-key-strip proof), `spawn-claude.test.ts` (`--bare`-never).

## Context

The 2026-06-23 assumption audit found (grep-confirmed) that glean had **zero auth-failure detection**: a spawn
that fails because the subscription login expired was recorded as a generic `failed` task. In an **unattended
weekend drain** that is the worst failure mode — every spawn fails the same way, the whole window is burned
retrying, and `glean morning` shows "a pile of failed tasks" with no hint that the cause was an expired login.
The auth cluster's verdict was **WEAKENED** partly on this gap (the auth mechanism itself works for the dominant
case; the *blind spot* was the problem). The print-mode OAuth-non-refresh behavior in `claude` is real and makes
a mid-drain token expiry plausible, so the missing detection is load-bearing for the drain's honesty.

**Evidence boundary:** the exact `claude -p` auth-failure shape has **never been captured** (like the WEEKLY
block before ADR-0003). glean is subscription-auth, so the likely signal is claude's own STDERR prose
("Invalid API key · Please run /login", "credentials expired") rather than an API 401 — but a structured 401
`result` is also possible. Both are detected; the shape is marked UNVERIFIED and a capture tripwire is armed.

## Decision

**1. Detect an auth failure and STOP the run loudly (built).** `classify.ts` exposes a narrow stderr regex
(`AUTH_ERROR_RE`, matched on claude's *stderr* — its operational errors — not model stdout, so a dossier *about*
authentication can't trip it) and a structural stdout detector (`isStreamAuthErrorLine`: a `result` with
`api_error_status: 401`, or a top-level authentication error). `spawn-claude.ts` sets `SpawnOutcome.authError`
and writes `<task>.AUTH-CAPTURE.txt` the first time it fires (so the real shape self-documents). The executor
flags `TaskResult.authExpired`; `pipeline.ts` stops the run with `reason: 'auth-error'` (**exit 50**) on the
first flag — an expired token dooms every later spawn, so stopping is the correct, non-wasteful behavior — and
`glean morning` renders a loud **"AUTH EXPIRED — re-run `claude /login`"** banner instead of a wall of failures.

**2. The scheduled-auth path (BUILT 2026-06-23).** The robust fix for the underlying *cause* (non-interactive
OAuth not refreshing) authenticates scheduled/drain runs via `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`
(re-verified live 2026-06-23: a **subscription** token, 1-year, inference-only, **no API key** — does *not*
violate the constraint). `glean auth setup-token` reads the token from stdin and stores it `0600` at
`~/glean/state/auth-token` (rejecting an `sk-…` API key); `glean run --drain` injects it as
`CLAUDE_CODE_OAUTH_TOKEN` **and strips** `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / the
`CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}` flags (claude precedence: API_KEY > AUTH_TOKEN > OAUTH_TOKEN > /login),
so the subscription token wins; glean **never** passes `--bare` (it ignores the token — INVARIANT). The injection
is **drain-only** — a plain `glean run` is byte-identical. **NEW tradeoff (recorded):** a long-lived
`CLAUDE_CODE_OAUTH_TOKEN` at rest is a larger secret surface than the short-TTL `~/.claude/.credentials.json`;
the drain-only injection + the strip-set + `0600` bound the blast radius.

## Status / what would change this

- **Capture the real shape** (the armed `AUTH-CAPTURE.txt` tripwire fires on the first live auth failure): drop
  it into a `classify.ts` fixture, tighten `AUTH_ERROR_RE` / `isStreamAuthErrorLine` to the verified shape, and
  promote it from UNVERIFIED. Until then, accept a small false-positive risk (an stderr auth-phrase or a
  structured 401 stops the run — conservative, and a stopped run is recoverable).
- **The scheduled-auth path is now BUILT** (above). **TRACKED-PENDING:** the live **Spike-A re-validation** —
  run one real multi-hour weekend drain (token-less CONTROL → token-backed TREATMENT) and confirm no mid-drain
  401; **only then** promote this ADR to 're-validated' and flip the classify `UNVERIFIED` tag. Per the ADR-0001
  discipline: do NOT promote before the capture. (The auth-error DETECTION already exits 50 + warns if a 401 does
  occur, so an unattended drain fails loudly, not silently, in the meantime.)
- **False-positive escape hatch:** if the UNVERIFIED detector ever stops healthy runs in practice, gate the
  run-stop behind the structured-401 signal only (keep the stderr regex as a softer, non-halting note).
