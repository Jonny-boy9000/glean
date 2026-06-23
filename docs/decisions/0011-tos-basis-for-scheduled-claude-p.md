# ADR-0011 — ToS basis for scheduled/unattended `claude -p` (gray-but-defensible, one leg UNVERIFIED)

- Status: **Accepted** (the basis is recorded; the unattended-vs-interactive leg is **UNVERIFIED**) — 2026-06-23
- Enforced at: `src/lib/runDrain.ts` + `src/lib/schedule.ts` headers (tagged `ASSUMPTION[ADR-0011] UNVERIFIED`);
  the watchlist file `docs/watchlist/tos-automation-drift.md`; the README "Is this allowed?" answer (already
  dated/conditional, PR #31).
- Supersedes / Superseded by: none. Hands the existential tripwire to [ADR-0008](./0008-spawn-backend-seam.md).

## Context

glean's entire value rests on driving the user's own subscription via headless `claude -p` on a schedule. PR #31
made the user-facing README answer **dated and conditional** ("As of 2026-06-23, yes — with caveats"), but the
2026-06-23 [assumption audit](../strategy/2026-06-23-assumption-audit.md) (#3, verdict **WEAKENED / existential**)
found no ADR recorded the *basis*, so a future session had nothing load-bearing to read before touching the
unattended-execution sites. This ADR records the evidence boundary. **External facts re-verified live 2026-06-23**
against primary sources (cited inline); the knowledge cutoff is January 2026, so these carry dates and a watch.

What is verified vs. assumed:
- **VERIFIED — it drives the OFFICIAL binary, not an extraction harness.** glean spawns Anthropic's own
  `claude -p` subprocess; it extracts/reuses **no** OAuth token outside that binary, does **no** proxying, shares
  **no** account, resells **no** API access. It is therefore **NOT** the "OpenClaw" class Anthropic acted against
  (third-party agents reusing subscription OAuth credentials). The reselling design glean explicitly dropped
  (`glean.md` §2) is genuinely not tripped.
- **VERIFIED-as-of-date — `claude -p` still draws from the subscription pool.** The May-2026 plan to move
  headless/Agent-SDK usage onto separate metered credits was **paused** (June 15 2026); the canonical article
  still says it "still draw[s] from your subscription's usage limits" (re-verified 2026-06-23,
  `support.claude.com/en/articles/15036540`). Paused, **not** cancelled.
- **VERIFIED — the Consumer-Terms automation clause.** Anthropic's Consumer Terms (`anthropic.com/legal/consumer-terms`,
  eff. 2025-10-08) permit non-API automation only via an API key OR **"where we otherwise explicitly permit it."**
  glean has no API key; its basis is the "explicitly permit it" limb, which legal analyses read as covering the
  *official* Claude Code CLI (Anthropic's own docs promote `tail -f log | claude -p` and ship Claude Code GitHub
  Actions on cron). This is **gray-but-defensible**, not an unconditional "Yes".
- **UNVERIFIED (the load-bearing edge) — unattended/scheduled vs. interactive.** §3 spells out neither, and the
  written terms do not textually carve out *official-binary automation*. Whether a fully-unattended scheduled
  drain counts as the permitted "interactive use" is **untested**. Anthropic itself drew an interactive-vs-headless
  line in its May-2026 metered proposal, which is exactly what makes this leg gray. Tagged `UNVERIFIED` at the
  `runDrain.ts`/`schedule.ts` sites.

## Decision

**Record the basis as gray-but-defensible, not as a settled "Yes"; mark the unattended edge UNVERIFIED at the
code sites; keep the README answer dated/conditional.** Do not assert blanket permission anywhere. The
metered-billing un-pause is the **existential tripwire** — it is watched weekly (`docs/watchlist/tos-automation-drift.md`)
and is the build trigger for the ADR-0008 API hedge.

## Status / what would change this

- **BROKEN** if Anthropic (a) un-pauses metered `claude -p` billing (then headless is pay-per-token, effectively
  requiring an API key — the load-bearing "no API key" constraint forbids that path; build the ADR-0008 hedge),
  or (b) amends the Consumer Terms / Usage Policy to add an explicit "interactive use only" / "no unattended
  automated subscription use" clause, or narrows the §3 "explicitly permit it" limb, or (c) extends the
  OpenClaw-class enforcement to subprocess-driving of the official CLI.
- **HOLDS (cleanly)** only if Anthropic publishes explicit help-center language permitting scheduled/headless
  `claude -p` on a subscription — then the UNVERIFIED tag is removed and this is promoted.
- **WATCH:** the VentureBeat "Anthropic reinstates OpenClaw / third-party agents — with a catch" item; re-verify
  what "the catch" is — it bears on whether unattended subscription use becomes condition-bound. See the watchlist.
