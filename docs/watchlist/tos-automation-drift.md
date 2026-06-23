# Watchlist — ToS / automation drift (manually bumped; a stale `last_checked` IS the overdue signal)

> The structured precursor to the `watch.ts` feature (hardening roadmap Phase 3). Until that ships, bump each
> `last_checked` **at every release and on the stated cadence**. Backs [ADR-0011](../decisions/0011-tos-basis-for-scheduled-claude-p.md)
> (ToS basis) and [ADR-0008](../decisions/0008-spawn-backend-seam.md) (the API hedge whose build trigger is the
> metered un-pause). The full watchlist also lives in `CLAUDE.md` → "Watchlist".

| id | severity | cadence | canonical source | last_checked | BROKEN-trigger |
|---|---|---|---|---|---|
| `metered-billing-unpause` | **EXISTENTIAL** | weekly | `support.claude.com/en/articles/15036540` | 2026-06-23 (SAFE — paused, "still draw from your subscription's usage limits") | the article stops saying *"still draw from your subscription's usage limits"*, OR a changelog/email gives an advance-notice effective date. → **build the ADR-0008 API hedge** |
| `tos-automation-clause` | high | weekly | `anthropic.com/legal/consumer-terms` §3 + the "Use Claude Code with your Pro/Max plan" article | 2026-06-23 (§3 "where we otherwise explicitly permit it", eff. 2025-10-08) | any new "interactive use only" / "no unattended automated subscription use" clause, OR §3 dropping/narrowing "explicitly permit it" |
| `openclaw-reinstatement-catch` | medium | weekly | VentureBeat "Anthropic reinstates OpenClaw / third-party agent usage on subscriptions — with a catch" (re-fetch via an authenticated tool; the public fetch 403'd) | 2026-06-23 (UNRESOLVED — "the catch" unknown) | "the catch" turns out to condition-bind unattended subscription use (e.g. requires registration / a flag / interactive-only) |

## How to use

- **Weekly (or at each release):** open each canonical source, confirm the BROKEN-trigger has NOT fired, bump
  `last_checked` to today. A `last_checked` older than its cadence is itself the alarm.
- **If `metered-billing-unpause` fires:** that is the single existential risk to the whole thesis — start the
  ADR-0008 API-backend build, and (per the GTM contingency in `docs/launch/LAUNCH-PLAN.md` §F) postpone any loud
  launch and re-anchor messaging on billing-independent **discovery** value.
- **If `tos-automation-clause` fires:** the `runDrain.ts`/`schedule.ts` `ASSUMPTION[ADR-0011] UNVERIFIED` tag
  becomes a confirmed restriction — supersede ADR-0011 and reassess the unattended/scheduled path.
