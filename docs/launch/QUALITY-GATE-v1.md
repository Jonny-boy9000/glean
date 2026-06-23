# Quality gate v1 — pre-committed draft-quality bar (lock this BEFORE the next dogfood)

> Implements the [GTM plan](../strategy/2026-06-23-go-to-market-distribution.md) §Metrics. Written and committed
> **before** the next dogfood so the thresholds **cannot be tuned after seeing results** — the previous
> dogfood writeup (`docs/open-work/03-dogfood-results.md`) published glowing prose and zero ratio, which is the
> exact failure mode this gate exists to prevent. Date: 2026-06-23.

## The two bars (never blended)

| Bar | Threshold | Gates what | Judged by |
|---|---|---|---|
| **draft-impl keep-rate** | **≥ 33%** | **Can BLOCK the loud (Show HN) launch** | branch merged or cherry-picked within 14 days |
| **research-dossier keep/action-rate** | **≥ 30%** | Advisory — informs discovery/prioritizer, NOT launch | dossier file still referenced/edited, or a later JSONL session on its topic appears |

**Anchors (dated/sourced):** GitHub Copilot ~27–30% inline acceptance with ~88% of accepted chars retained
(multiple 2026 sources — verified). Cursor agent merge ~35% (WEAKER anchor — live search surfaced a Supermaven
autocomplete 72% figure, not a clean agent-merge rate, so treat ~35% as directional, not verified).

## The sampling rule (non-negotiable)

- **N ≥ 30 rated outputs of that type, across ≥ 3 distinct repos that are NOT the glean repo.** (The dogfood
  already showed glean flagging its own scanner strings — self-referential false positives distort the rate.)
- **Below N = 30: report "insufficient evidence" — do NOT pass or fail.** Binomial caveat: 30% at N=10 is
  ±~28pp, so a near-miss at low N means "gather more N", not a verdict.

## The judge (objective, not vibes)

The judge is an **objective git/JSONL artifact**, per the existing post-hoc-overlap design — NOT the maintainer's
in-the-moment opinion:
- **draft-impl:** the prep branch was merged or cherry-picked into the project within 14 days.
- **research-dossier:** the dossier file is still referenced/edited later, or a JSONL session on its topic appears
  after the dossier date.
The manual `glean rate <id> kept|discarded|actioned` click is a **secondary, lower-weight** signal.

## What this gate is NOT

- It does **not** target SWE-bench resolve rates (80–95%) — that measures a different event (curated tasks,
  hidden tests). A result below bar means **fix discovery/prioritizer/templates**, not abandon the metric.

## Tooling (so the gate is computed, not asserted)

- Ship **`glean rate --report`** — a trivial query over the existing `user_rating` / `candidate_type` columns
  (no schema change) that prints keep-rate per type with N. The gate is then read off telemetry, never a writeup.

## Launch interaction

- If the **draft-impl keep-rate misses ≥33% at N≥30, FIX QUALITY before the loud launch** — do not launch a weak
  number. If N<30 at launch time, the GO/NO-GO gate accepts an honest "insufficient evidence, N too low" label
  instead (see LAUNCH-PLAN §F).
