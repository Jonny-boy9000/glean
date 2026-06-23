# ADR-0012 — The "free idle capacity" thesis is true but CONDITIONAL

- Status: **Accepted** (HOLDS, scoped — audit #12) — 2026-06-23
- Enforced at: `CLAUDE.md` "What glean is" (already reframed conditional), the README hero/FAQ, the
  `BLIND_SPOT_NOTE` in `src/lib/pacing.ts`. No engine change — `recommendTier()` already gates by design.
- Related: [ADR-0007](./0007-internal-usage-loader.md) (the local-JSONL blind spot the conditional rests on),
  [ADR-0008](./0008-spawn-backend-seam.md) / [ADR-0011](./0011-tos-basis-for-scheduled-claude-p.md) (the metered
  tripwire).

## Context

glean's pitch is "consume the weekly capacity you already paid for and would otherwise lose." The 2026-06-23
[assumption audit](../strategy/2026-06-23-assumption-audit.md) (#12) found this **HOLDS but is CONDITIONAL**, and
the cross-check **disproved** the auditor's attempt to overturn it to WEAKENED — so it stays HOLDS, scoped:

- **Verified (re-confirmed live 2026-06-23):** the weekly window is real and **does not roll over** — unused
  capacity expires at the per-account reset (`support.claude.com`). headless `claude -p` still draws from the
  subscription pool (metered change paused, ADR-0011). So the "expires" premise is sound.
- **The conditional:** "free idle capacity" assumes the user actually has an **idle tail** on their **SHARED**
  weekly pool — the same cap funds Claude Code + claude.ai chat + Cowork. A heavy week can leave **no tail**, in
  which case glean's drain competes with the user's *own* real sessions rather than spending slack. The audit's
  loud-public-pain evidence (users hitting the cap mid-week) is exactly this surplus-poor segment.
- **Not strictly "use-it-or-lose-it" for everyone:** Pro/Max users can opt into **extra usage** (Settings →
  Usage; **off by default**; billed at API rates with a spend cap — verified 2026-06-23). For a user who enabled
  that toggle, draining past the included limit can **cost real money** — so glean must never tell *every* user
  "the only alternative is losing it."

## Decision

**State the thesis in the conditional, everywhere, and let the existing pacing engine enforce it — no engine
change.** `recommendTier()` already returns `skip` when the user is not underspending (the pace-gated drain only
spends slack). The honest framing:
- CLAUDE.md / README / FAQ say "free idle capacity" is **conditional on having an idle tail on the shared pool**,
  and point users at **`glean usage`** to check *before* `glean schedule enable`.
- Never assert "the only alternative is losing it" unconditionally — name the opt-in **extra usage** overage.
- `pacing.ts` `BLIND_SPOT_NOTE` records that the local-JSONL measure can't see claude.ai-web/Cowork/other-machine
  spend, so `glean usage` can *under*-count true cap usage (ADR-0007) — another reason the thesis is conditional.

## Status / what would change this

- **BROKEN ("expires" premise dies)** if Anthropic introduces weekly **rollover/banking** of unused capacity.
- **Framing changes** if **extra usage** becomes **default-on** (then draining past the limit is silently
  metered for everyone — re-word hard, and gate the drain on the included limit only).
- **Thesis-level BROKEN** if metered `claude -p` billing un-pauses (ADR-0011 existential tripwire).
- Watched on the `(MONTHLY) Weekly rollover/banking + extra-usage default` line of the watchlist.
