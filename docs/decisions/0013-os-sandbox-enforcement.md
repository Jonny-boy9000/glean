# ADR-0013 — OS-sandbox enforcement (`enforce_spawn`): the HARD spawn boundary, where the platform has one

- Status: **Accepted** (1a built + tested; the live enforcement PROOF + 1b verb-restore are **TRACKED-PENDING** on non-Windows hardware) — 2026-06-23
- Supersedes: the **deferred OS-sandbox leg** of [ADR-0009](./0009-spawned-session-trust-boundary.md). ADR-0009's
  Narrow default + `strict_spawn` decisions **still stand** — this ADR only builds the posture 0009 left designed-not-built.
- Enforced at: `src/lib/sandbox.ts` (`detectSandboxAvailability` / `resolveSpawnPosture` / `buildSandboxSettings`),
  `src/lib/spawn-claude.ts` (`buildClaudeArgs` → `--settings` + `--setting-sources`, tagged `ASSUMPTION[ADR-0013]`),
  `src/lib/config.ts` + `types.ts` (`enforce_spawn`), `src/cli.ts` (posture resolution + the unavailable-warning),
  `src/lib/executor.ts` (per-task settings + `enforceSpawn` ctx). Tests: `sandbox.test.ts`, `spawn-claude.test.ts`
  (argv), `v29-sandbox-fallback` (Windows → Narrow + warning, no `--settings`), `v30-sandbox-enforcement`
  (the REAL proof, self-skipped off sandbox-capable hardware).

## Context

ADR-0009 narrowed the spawned-session boundary (dropped `node`/`npm run`) and added `strict_spawn`, but on
**every** platform left in-session subprocess writes as *defense-in-depth, not a hard guarantee* — because the
allow-list bounds tool **names**, not what an allow-listed interpreter then writes, and the only real filesystem
boundary is the OS sandbox. **Verified live 2026-06-23** (code.claude.com/docs/sandboxing + /cli-reference,
re-confirmed by a claude-code-guide agent):
- `--settings '<json>'` accepts an **inline JSON string** and overrides settings keys **for that session only** —
  zero mutation of the user's `~/.claude/settings.json` (confirmed against `claude --help` locally too).
- keys: `sandbox.enabled`, `sandbox.failIfUnavailable` (**fail-closed** if bwrap/socat missing — the safety
  hinge), `sandbox.allowUnsandboxedCommands` (`false` = no `dangerouslyDisableSandbox` escape), and
  `sandbox.filesystem.{allowWrite,denyRead,allowRead}` (path prefixes `/` abs, `~/` home, `./` cwd/project).
  Default write scope is **cwd + $TMPDIR**.
- the sandbox **auto-allows a linked worktree's shared `.git`** (refs/index) but keeps `.git/hooks` + `.git/config`
  **denied** — exactly complementing glean's hook-neuter.
- `--setting-sources user,local` stops a project's own `.claude/settings.json` from widening the injected policy.
- **macOS (Seatbelt) + Linux/WSL2 (bubblewrap) ONLY. Native Windows has no OS sandbox.**

## Decision

Add the **`enforce_spawn`** posture (opt-in `config.json` bool). Resolution (most-restrictive-wins):
`strict_spawn` > `enforce_spawn` > Narrow.
- **Where the sandbox is available** (mac/Linux/WSL2), an `enforce_spawn` draft-impl/research spawn gets an inline
  `--settings` injecting `{enabled, failIfUnavailable:true, allowUnsandboxedCommands:false, filesystem:{allowWrite:[worktree], denyRead:[$HOME secrets (+ the main checkout for draft-impl)], allowRead:[project for research]}}` + `--setting-sources user,local`. This makes in-session subprocess writes a **HARD OS boundary**.
- **On native Windows** `enforce_spawn` falls back to **Narrow with a LOUD `console.error` warning** (never a
  silent unsandboxed run) — `strict_spawn` remains the only hard guarantee there.
- **1a (this PR)** ships the security core with the **existing Narrow verb set** (no `node`/`npm run`). **1b
  (tracked follow-up)** restores those verbs **only on the active-sandbox path** (the OS now bounds them),
  recovering the draft quality the Narrow default sacrificed — decoupled so a sandbox-init regression can't
  re-open the hole with *more* verbs.
- The bare `glean run` path (no `enforce_spawn`, or Windows) is **argv byte-identical** — `--settings` is appended
  only when present (`buildClaudeArgs`, regression-locked by `spawn-claude.test.ts` + the v18 byte-identical test).

## Status / what would change this

- **TRACKED-PENDING (not claimed closed):** `v30` (the REAL out-of-worktree-write-refused proof) only runs on a
  sandbox-capable box with a real `claude`; it **self-skips on Windows and prints the skip**, so a green Windows
  suite is never mistaken for one that *proved* the boundary. Until it passes on a mac/Linux/WSL2 runner, the
  boundary is "enforced where run, untested-here." 1b (verb restore) is also pending that proof.
- **ON NATIVE WINDOWS — glean's primary platform — the audit's #1 BROKEN finding is mitigated (Narrow/`strict_spawn`)
  but NEVER resolved to a HARD filesystem boundary** (the sandbox does not run there). This is stated in those
  words here, in CLAUDE.md, and in the hardening roadmap, by design.
- **Flip toward a hard default** if Claude Code ships an out-of-the-box sandbox on Windows (then `enforce_spawn`
  could become the default there) — watch `code.claude.com/docs/sandboxing` + releases.
- **Schema drift** (`sandbox.*` key renames) would silently no-op `buildSandboxSettings` → the exact-JSON
  regression test + `failIfUnavailable:true` (fail-closed) are the mitigations; the `(WEEKLY — safety)` watchlist
  line tracks it.
