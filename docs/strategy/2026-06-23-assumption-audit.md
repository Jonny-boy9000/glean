# Glean — Load-Bearing Assumption Audit (2026-06-23)

> A red-team of the assumptions in `CLAUDE.md` (+ the ADRs they reference) that this project rests on.
> Method: 9 auditors each tried to **falsify** their assumption; a diverse-stance adversarial cross-check
> enforced the house rule (*"a finding that overturns a prior decision is a hypothesis to disprove —
> verify the negative case before asserting"*); a completeness critic then found the gaps the first pass
> missed; 4 gap-fill auditors closed them. External facts (ToS, billing, plan economics, permission
> semantics) were verified against **primary sources** live on 2026-06-22/23, not model memory (cutoff
> Jan 2026). 28 agents total across two passes.

## TL;DR — the foundation is sound on the *business model*; the cracks are in the *safety kernel*

The economic/ToS/billing thesis **survives** scrutiny as a scoped, time-bounded fact: the weekly window is
real, unused capacity does not roll over, and headless `claude -p` **still draws from the subscription pool**
(re-verified 2026-06-23 — the metered-billing change is *paused, not cancelled*). The genuinely new and
**higher-stakes** finding is that three internal safety/honesty invariants `CLAUDE.md` marks "do not violate"
rest on **unverified assumptions that do not hold as stated** — and none of them has an ADR. The decision
record stops at ADR-0008; the safety kernel was never audited.

**The single most important finding:** the `--allowedTools` allow-list is **not a hard filesystem boundary**.
Verified live at `code.claude.com/docs/permissions`: Read/Edit deny rules *"do not apply to arbitrary
subprocesses that read or write files indirectly, like a Python or Node script that opens files itself,"* and
the OS sandbox (the only real filesystem boundary) is **opt-in and enabled nowhere in glean**. glean grants
`Bash(node:*)` and `Bash(npm run:*)` under `--permission-mode acceptEdits`, so an allow-listed test/interpreter
verb can write or exfiltrate **outside the worktree** — including the user's `main` checkout and
`~/.claude/.credentials.json`. That directly contradicts the `CLAUDE.md` constraint *"read-only against the
user's primary checkouts."* It is **BROKEN** as a hard guarantee (defense-in-depth only).

This is exactly the failure mode the ADR discipline exists to catch: **two `deny.ts` comments assert a "real
guarantee"** (worktree isolation at lines 6–7; the allow-list per ADR-0002) — and they contradict each other,
neither is tested, and the test harness *structurally cannot* catch the hole (the fake-claude stub runs shell
with zero permission enforcement).

## The register (risk-ranked; adjudicated verdict = after cross-check)

| # | Assumption (where stated) | Class | Verdict | Risk if wrong | Survives challenge? |
|---|---|---|---|---|---|
| 1 | **Allow-list is a HARD default-deny filesystem boundary** the spawned model can't escape (`deny.ts`, ADR-0002, CLAUDE.md L45) | ASSUMED | **BROKEN** | high | yes — overturn stands on a **primary source** (Anthropic permission docs); the hole is by design, sandbox is off |
| 2 | **Worktree isolation is "the *real* guarantee"** (`deny.ts:6-7`, `draft-git.ts`) | ASSUMED | **WEAKENED** | high | yes — worktree bounds git-ref mutation only, not subprocess file writes; contradicts ADR-0002's own "allow-list is the real boundary" |
| 3 | **ToS: scheduled headless `claude -p` is permitted** (README "Is this allowed? → Yes.", glean.md §2) | ASSUMED | **WEAKENED** | existential | yes (softened) — permitted-**but-gray** under Consumer-Terms §3 "where we otherwise explicitly permit it"; glean is genuinely **NOT** the banned OpenClaw token-extraction class; the absolute "Yes." overclaims |
| 4 | **Headless auth works under the scheduler; sleep-proofing; Windows-first** (CLAUDE.md, ADR-0004) | VERIFIED | **WEAKENED** | high | yes — a current/unfixed print-mode OAuth-non-refresh bug + **zero 401 detection** in glean (grep-confirmed) + Spike-A clearance is now STALE; sleep-proofing (ADR-0004) holds |
| 5 | **"Verified" draft test status is trustworthy** (CLAUDE.md headline, `draft-test.ts`) | ASSUMED | **WEAKENED** | medium | yes — a fresh worktree has no `node_modules` → the common Node/TS case is structurally `none`; an unanchored env-signature scan can downgrade a real `fail`→`none`; README L17/L19 "verified tests: pass" overclaims |
| 6 | **Privacy/data-scope of reading `~/.claude` history + `--add-dir project_path`** (`discover-jsonl.ts`, `executor.ts`) | ASSUMED | **WEAKENED** | medium | partial — full transcripts (may hold pasted secrets/PII) are read + excerpted to `~/glean` + SQLite at rest; a candidate from one repo can grant a spawn read-scope to another sensitive repo; never stated, no ADR |
| 7 | **Heuristic-only ranking + self-relative pacing are sound** (`prioritize.ts`, `pacing.ts`, ADR-0005) | ASSUMED | **WEAKENED** | medium | yes — ranking weakened by the project's **own** post-MVP self-falsification + an `est_tokens` **doc-lie** (docs say "×1.3", code hardcodes 2000/4000/5000/6000); pacing is **REINFORCED** (fails safe) |
| 8 | **No usage probe (Spike 0) + local-JSONL reconstruction** (CLAUDE.md, ADR-0007) | VERIFIED | **WEAKENED** | medium | yes — Spike 0 holds on `claude` 2.1.185; the `haircut` is a near-useless compensator; a server-truthful weekly signal exists upstream (v2.1.80 `rate_limits.seven_day`) but isn't yet in glean's **headless** stream |
| 9 | **Per-model pool economics: Sonnet has its own pool; route Sonnet** (ADR-0006/0005) | ASSUMED | **WEAKENED** | low | yes — **keep `--model sonnet`**; the Sonnet-only pool is documented-**CORRECT** (do NOT invert to "Opus-only"); weakened only by a live Sonnet drain-both bug + the paused-metered risk |
| 10 | **`max_parallel=1` + no cross-invocation caching** (CLAUDE.md L46/L48) | ASSUMED | **WEAKENED** | low | yes — rate-budget half HOLDS (single shared bucket verified); caching wording is stale (cross-invocation cache **is** free on subscription, auto-1h-TTL, but cwd/worktree-keyed so glean misses it); NEW: `--parallel 2` same-project worktree race never audited |
| 11 | **Rate-limit signal: structured `rate_limit_event`; weekly inferred by a 6h cut** (ADR-0001/0003) | ASSUMED | **HOLDS** | medium | overturn did **not** survive — session shape VERIFIED; the weekly shape is a known-armed gap (BLOCK-CAPTURE tripwire live); cheap hardening = read `seven_day*` `rateLimitType` first-class |
| 12 | **Core economic thesis: idle capacity is free & expires** (README, CLAUDE.md) | ASSUMED | **HOLDS** (scoped) | high | overturn to WEAKENED did **not** survive — (a) real weekly window + (b) no-rollover + (c) subscription-pooled `claude -p` all verified present-tense; (d) idle-tail is gated by the pacing engine *by design* |
| 13 | **Metered-billing change is PAUSED, not live** (CLAUDE.md, strategy memo, ADR-0008) | VERIFIED | **HOLDS** (as-of 2026-06-23) | existential | yes — re-verified live at `support.claude.com/en/articles/15036540` ("nothing has changed… still draw from your subscription's usage limits"); a deferral with promised advance notice, **not** permanent |

## What needs action now (independent of any external flip)

1. **Close the spawned-session filesystem hole (P0, high).** The breach is verified against Anthropic's own
   permission docs: `Bash(node:*)`/`Bash(npm run:*)` (`deny.ts:60-65`) under `acceptEdits`
   (`spawn-claude.ts:232`), sandbox enabled **nowhere** → `node -e "fs.writeFileSync('C:/Glean/…')"`, an npm
   script, or a `git commit`-fired pre-commit hook all run **outside** the permission layer and can mutate/
   exfiltrate the main checkout + `~/.ssh` + `~/.claude/.credentials.json`. **Fix (pick one):** (a) enable
   Anthropic's OS Bash **sandbox** for spawns, scoped to the worktree/dossier dir and deny-reading `$HOME`
   secrets + the main checkout; or (b) drop the interpreter verbs from the default allow-list and run the
   test via glean's own out-of-session `runTestCommand` (`draft-test.ts` already does this) + run `git commit`
   with hooks neutered (`--no-verify` / `core.hooksPath=`). *(Note: the compound-`&&` bypass is confirmed
   **fixed** upstream; `npx`/env-runners are confirmed **not** stripped, so `Bash(npm run:*)` still authorizes
   any `package.json` script.)*
2. **Reconcile the two contradictory "real guarantee" claims** in `deny.ts` (P0, low) — pick one truthful
   framing (defense-in-depth, **not** a hard boundary, unless the sandbox is on) across `deny.ts:6-7` +
   ADR-0002, and add a **real enforcement test** (against the actual `claude` or a permission-faithful stub)
   asserting an out-of-worktree `fs.writeFileSync` is refused. The current harness cannot prove the boundary.
3. **Add 401/`authentication_error` detection** (P0, medium) — grep-confirmed glean has none; a token-expired
   weekend drain is silently recorded as generic `failed` tasks. Surface "AUTH EXPIRED" on `glean morning`;
   add a 401 tripwire fixture mirroring BLOCK-CAPTURE; adopt `claude setup-token` →
   `CLAUDE_CODE_OAUTH_TOKEN` as the scheduled-auth path (re-verified: 1-year, **subscription** auth,
   inference-only, **no API key** — does *not* violate the constraint; must NOT pass `--bare`). Record the new
   tradeoff: a long-lived token at rest is a larger secret surface than the short-TTL `.credentials.json`.
4. **Downgrade README "Is this allowed? → Yes."** (P0, low) to a dated, conditional answer (official binary +
   no token extraction = not the OpenClaw class; rests on §3's "explicitly permit it"; unattended-vs-
   interactive is the untested edge). Drop/qualify "same invocations you could type by hand" — Anthropic
   itself drew the interactive-vs-headless line in its May-2026 metered proposal.
5. **Fix the `est_tokens` doc-lie** (P1, low) — `CLAUDE.md` L89 + `glean.md` L21 say "× 1.3"; the code
   hardcodes per-source constants. This is the *exact* anti-drift trap the ADR discipline exists for: a future
   session reading that line will "fix" the wrong thing.
6. **Soften the "verified tests: pass" hero** (P1, medium) — make `node_modules` available before
   `runTestCommand` (junction/symlink from the base checkout) so a pass is actually reachable for Node/TS;
   anchor `ENV_FAILURE_SIGNATURES` to the runner preamble so a real `fail` printing "enoent"/"cannot find
   module" isn't downgraded to `none`; split `none` into distinguishable receipt states. Until then, soften
   README L17/L19/L166 + CLAUDE.md to "best-effort test status."

## ADRs to add/supersede (the decision record stops at 0008)

- **ADD ADR-0009 — "Spawned-session trust boundary."** State *in the conditional* that `--allowedTools`
  bounds tool-call **names**, not what allow-listed interpreter verbs then do (verbatim Anthropic-docs quote);
  demote `deny.ts:6-7`'s "worktree isolation is the *real* guarantee"; reconcile with ADR-0002; fold in the
  ToS basis (§3 official-binary exception + the untested unattended edge + the metered-pause tripwire). Tag
  `spawn-claude.ts:236` `ASSUMPTION[ADR-0009] UNVERIFIED`.
- **ADD ADR-0010 — auth.** `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` as the scheduled/drain auth path
  (subscription, 1-year, inference-only, no API key; `--bare` ignores it). Record the long-lived-token-at-rest
  tradeoff.
- **ADD a test-status-honesty ADR** — the only load-bearing honesty decision with no ADR. State `none` is
  best-effort and overloaded; record the no-`node_modules` structural-`none` problem + the env-scan downgrade.
- **ADD/UPDATE a privacy ADR** — `discover-jsonl` reads full `~/.claude` transcripts (may hold secrets/PII),
  excerpts land in `~/glean` + the SQLite DB at rest, and a candidate from one repo can grant a spawn
  `--add-dir` read-scope to another sensitive repo. State the data-minimization/scope-confinement policy
  (e.g. only grant project read-scope to the repo the candidate came from; redact obvious secrets).
- **UPDATE ADR-0006 status note (do NOT supersede the pool claim).** AFFIRM "Sonnet-only pool" as
  documented-correct (primary sources: Anthropic Nov-24-2025 "Sonnet now has its own limit"; the Max-plan
  page; `anthropics/claude-code#55663`); flag the live Sonnet drain-both bug + the paused-metered risk.
  **Reject** any "supersede to Opus-only" — that re-introduces the ADR-0001 failure mode *in reverse* (a
  wrong "correction"). The cross-check caught a sub-auditor making exactly this mistake.
- **ANNOTATE ADR-0007 / ADR-0003** — dated Spike-0 re-verification (holds on 2.1.185 + closed issues
  #40395/#40793/#44328); record the upstream server-truthful weekly signal (`rate_limits.seven_day`,
  v2.1.80) as the future budget source; keep ADR-0003 open with the cheap `seven_day*` hardening + tripwire.

## Watchlist — time-sensitive external facts (re-check cadence in parens)

- **(WEEKLY — existential) Metered `claude -p` billing un-pause.** Canonical:
  `support.claude.com/en/articles/15036540`. BROKEN trigger: it stops saying *"still draw from your
  subscription's usage limits"*, OR a changelog/email gives an advance-notice effective date. This is the
  build trigger for the ADR-0008 API hedge. Holding as of 2026-06-23.
- **(WEEKLY — NEW, safety) claude-code permission/sandbox semantics.** Watch `anthropics/claude-code`
  releases + `code.claude.com/docs/permissions` & `/sandboxing` for: an out-of-the-box sandbox default
  (would flip assumption #1 toward HOLDS), `--allowedTools` semantic changes, or any change to whether
  interpreter verbs run outside the permission layer.
- **(WEEKLY) ToS / Usage-Policy drift on automation.** Watch `anthropic.com/legal/consumer-terms` §3 + the
  "Use Claude Code with your Pro/Max plan" article for any explicit "interactive use only" /
  "no unattended automated subscription use" clause. Track the VentureBeat report that Anthropic
  "reinstates OpenClaw / third-party agent usage on subscriptions — with a catch" (fetch 403'd; re-verify
  what "the catch" is — it bears directly on whether unattended subscription use is condition-bound).
- **(WEEKLY) claude-code auth/credential changes** — a print-mode OAuth-refresh fix (relaxes 401 risk) or a
  `setup-token`/`CLAUDE_CODE_OAUTH_TOKEN` behavior change.
- **(MONTHLY) `rate_limit_event` schema drift** — renamed/removed `status`/`rateLimitType`/`error:"rate_limit"`
  fields break `classify.ts`. Today's weekly bucket names: `seven_day` / `seven_day_opus` / `seven_day_sonnet`.
- **(MONTHLY) Model-pool mechanics** — the Sonnet drain-both bug fix (restores ADR-0006 leg b), Opus/Sonnet
  equalization (changes the routing default), or a shipping headless `usage` subcommand (Spike-0 flip).
- **(MONTHLY) Weekly rollover/banking** — any carry-over of unused capacity kills the "expires" premise.
  Today: no rollover.

## Stale-but-recheckable (how to re-verify)

- **Spike A ("`claude -p` authenticates under Task Scheduler")** — STALE; the clearance pre-dates the
  print-mode OAuth-refresh regression. Re-verify with **one real multi-hour weekend drain** on the current
  binary, confirming no mid-drain 401. The single most important re-validation; pair it with the new
  401-detection work.
- **Spike 0 (no headless usage probe)** — verified on 2.1.185 (`claude --help` has no `usage`,
  `auth status --json` has no quota fields). Re-verify on each `claude` upgrade.
- **ADR-0007 weekly blind spot** — a server-truthful 7-day utilization signal shipped upstream (v2.1.80,
  `anthropic-ratelimit-unified-7d-utilization`) but is **not yet demonstrably in glean's headless `-p`
  stream** (glean captures only the 5h session utilization today). Re-verify via the armed BLOCK-CAPTURE
  tripwire whether a captured headless stream emits a `seven_day*` event.

## Method notes & honest caveats

- **The cross-check changed verdicts both ways.** It *restored* assumptions #11 and #12 (the auditor's
  overturn to WEAKENED did not clear the higher bar), and it *corrected the reasoning* on #9 while keeping
  the WEAKENED label (refusing to invert ADR-0006). This is the house rule working as designed.
- **No material overreaches** were found by the completeness critic — the audit is consistently conservative
  and self-corrects. Its biggest weakness was **scope**: the first 9 clusters audited the *business model*
  and almost none of the *safety kernel*; the gap-fill pass (#1, #2, #5, #6) closed that, and those four are
  now the highest-stakes findings on the board.
- **One inference, not a reproduction:** the auth WEAKENED leans partly on "Spike A is now stale" (a timing
  inference). The verified facts (cited upstream OAuth-refresh issues + zero-401-detection code) independently
  justify WEAKENED, but a live drain is needed to *confirm* a mid-drain 401 actually occurs.
- All external facts carry a verification date and a single canonical primary URL; where a secondary source
  disagreed (e.g. one blog claimed the metering change was "live"), the primary source was treated as the
  tiebreaker, not averaged.
