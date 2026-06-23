# ADR-0009 — Spawned-session trust boundary (the allow-list bounds tool *names*, not subprocess writes)

- Status: **Accepted** (Narrow default + opt-in `strict_spawn` hard-close shipped 2026-06-23). The deferred
  **OS-sandbox leg is now built** as the `enforce_spawn` posture — see **[ADR-0013](./0013-os-sandbox-enforcement.md)**
  (the Narrow/`strict_spawn` decisions below still stand; the live enforcement proof is tracked-pending off Windows).
- Date: 2026-06-23
- Enforced at: `src/lib/deny.ts` (`DEFAULT_TEST_COMMAND_ALLOW`, `draftImplAllowedTools`, tagged `ASSUMPTION[ADR-0009]`),
  `src/cli.ts` (`strict_spawn → []`), `src/lib/executor.ts` (allow-list comment + worktree hook-neuter),
  `src/lib/spawn-claude.ts` (the `--allowedTools` push). Tests: `src/lib/deny.test.ts`
  ("ADR-0009: the default EXCLUDES the arbitrary-code verbs node + npm run" / "strict_spawn …").
- Supersedes: corrects the load-bearing claims in `deny.ts` (was: "worktree isolation is the *real*
  guarantee") and ADR-0002's "the allow-list is the real boundary" — reconciled into the layered model below.

## Context

CLAUDE.md states a load-bearing constraint: **"read-only against the user's primary checkouts."** A 2026-06-23
assumption audit ([`docs/strategy/2026-06-23-assumption-audit.md`](../strategy/2026-06-23-assumption-audit.md))
found that, for the **draft-impl** path, this was **not mechanically enforced** — it was an assumption stated as
a guarantee. Verified against Anthropic's **own** primary docs (`code.claude.com/docs` permissions + sandboxing,
confirmed live 2026-06-23):

- **Permission rules do not constrain subprocesses.** A Read/Edit/`--allowedTools` rule bounds *which tools the
  model may call*, not what an allow-listed **interpreter** then does: *"deny rules block the built-in tools but
  not Bash subprocesses."* So `Bash(node:*)` → `node -e "fs.writeFileSync('<outside-the-worktree>', …)"`, or
  `Bash(npm run:*)` running an arbitrary `package.json` script, or a `git commit`-fired pre-commit hook, all
  execute **outside** the permission layer and can write/exfiltrate beyond the worktree (the main checkout,
  `~/.ssh`, `~/.claude/.credentials.json`).
- **The only real subprocess boundary is the OS sandbox — and it does not exist on native Windows.** Claude
  Code's filesystem sandbox is **macOS / Linux / WSL2 only** (Seatbelt / bubblewrap). glean is Windows-first;
  the sandbox is enabled nowhere. So on the primary platform there is **no OS-level way** to confine an
  in-session subprocess.
- **What IS bounded:** built-in `Edit`/`Write` are scoped to the worktree via `--add-dir` (acceptEdits mode);
  the default-deny allow-list means bare `Bash` is never granted; research-dossier/fetch-docs never get
  Write or interpreter verbs (so only **draft-impl** was exposed). The residual hole is exactly the
  draft-impl **test-command verb set**, which existed so the model could run the suite and iterate to green.

The honest framing was missing and two `deny.ts`/ADR-0002 comments asserted contradictory "real guarantees."

## Decision

Adopt a **layered boundary** and state it in the conditional (not as a hard guarantee on native Windows):
1. **Allow-list** bounds tool-call *names* (never bare `Bash`).
2. **`--add-dir`** bounds built-in `Edit`/`Write` to the worktree (the real write boundary for claude's own tools).
3. **Worktree isolation + deny-list** are in-session defense-in-depth against ref publishing/mutation.
4. **Interpreter/test verbs run outside the permission layer** — defense-in-depth only on native Windows.

Concrete changes (shipped 2026-06-23), per the user-chosen **"both, staged"** option:
- **Narrow (default):** drop the two arbitrary-code verbs `Bash(node:*)` and `Bash(npm run:*)` from
  `DEFAULT_TEST_COMMAND_ALLOW`; keep the declared runners (`npm test`, `npx vitest`, or a per-project
  `test_command`) so the model can still verify its own draft.
- **Hard-close (opt-in):** `config.json` `strict_spawn: true` collapses the in-session test-command allow-list to
  empty (`cli.ts`), leaving only `Edit`/`Write` + git add/commit/status/diff — **no in-session code execution**,
  a true "read-only against main" guarantee on every platform. glean still re-runs the test command
  out-of-session (`draft-test.ts`) for the surfaced status, so the receipt's test signal is unaffected.
- **Hook-neuter:** the disposable draft worktree gets `core.hooksPath` pointed at an empty dir, so an
  allow-listed `git commit` cannot fire a repo hook (`executor.ts`).

**Why not "enable the sandbox" as the default fix:** it is unavailable on the primary platform (native Windows).
It remains the right way to *restore safe in-session code execution* on macOS/Linux/WSL2 and is the deferred
follow-up below.

## Status / what would change this

- **DEFERRED (designed, not built):** enable Claude Code's OS sandbox (filesystem scope = the worktree, deny-read
  `$HOME` secrets + the main checkout) on macOS/Linux/WSL2, restoring full in-session code execution safely
  there. Not built because it cannot be validated on the Windows dev box (same discipline as the ADR-0008 seam).
- **NOT YET ENFORCED BY TEST against the live binary.** The argv-level tests pin the allow-list *shape*; the
  fake-claude stub has zero permission enforcement, so the harness cannot prove a real `node -e` write is
  refused. A real enforcement test needs the actual `claude` binary (a scenario whose spawn attempts an
  out-of-worktree `fs.writeFileSync` and asserts refusal). Until then this stays `ASSUMPTION[ADR-0009]`.
- **Flip toward a hard default** if Claude Code ships an out-of-the-box filesystem sandbox on Windows, or makes
  interpreter verbs run inside the permission layer — watch `anthropics/claude-code` releases +
  `code.claude.com/docs/permissions` & `/sandboxing` weekly (the new safety tripwire on the watch list).
