# Glean — Next-Wave Strategy (2026-06-22)

> Grounded in (1) a verified competitive-landscape research pass (21 agents, 42 candidates, 14 deep-verified)
> and (2) a codebase coupling audit of the four strategic questions. This memo answers "what is Glean,
> and where should it go," then lists the buildable work that follows from that answer.

## TL;DR

**Stay narrow, stay subscription-only, stay Claude-native — and deepen the one thing nobody else does.**
Glean's defensible wedge is the intersection of **(a) autonomous local cross-project *discovery*** (mining
`~/.claude/projects/*.jsonl` history + git TODOs/stale branches/PR comments + ROADMAP/handoff docs, ranked)
and **(b) the idle-weekly-capacity *drain* economics**. No tool in the verified set does both. Everything
else Glean does — scheduling, headless `claude -p`, worktree isolation, a morning receipt — is now
**commodity plumbing**, and as of ~2026 the platform owner ships it first-party.

## The landscape changed: Anthropic entered the category

The single most important finding: **Anthropic now ships first-party scheduled Claude agents.**
- **Claude Code Routines** (cloud, all paid tiers): saved prompt+repos → autonomous cloud Claude sessions
  on `claude/` branches, scheduled. **Subscription-only — it *rejects* an API key** (`/schedule` hidden if
  `ANTHROPIC_API_KEY` is set). But: **no discovery** (you author the prompt + pick repos), **no capacity
  thesis** (it deliberately *throttles* — 1h-min interval + daily cap — the opposite of draining), and **no
  local file access** (fresh GitHub clone, never sees local JSONL/branches).
- **Claude Code Desktop scheduled tasks** (local): scheduled fresh session, per-task worktree toggle,
  missed-run catch-up. Subsumes Glean's *plumbing* — but single-folder, fixed prompt, **zero capacity
  awareness**, no portfolio, no receipt.

Closest community tool: **jshchnz/claude-code-scheduler** (~500★, Windows Task Scheduler + `claude -p` +
worktree) — but it's manual cron-for-Claude: no discovery, ranking, dossier, pacing, or drain. Closest
*conceptual* match: **sleepwalker** (a "Morning Queue" overnight fleet) — but it's the *general nightly
agent* direction, macOS-only, multi-LLM, 0★ alpha, no capacity thesis.

**Implication:** the generic "scheduled background Claude agent" mechanic is commoditized and partly
platform-owned. Glean must NOT try to out-engineer scheduling/worktrees. The moat is discovery + capacity.

## Answers to the four questions

### #2 Product identity — narrow "capacity governor" vs broad "nightly agent"
**Recommendation: stay narrow.** The broad "advance everything while you sleep" category is crowded by
funded/first-party players (Anthropic Routines + Desktop tasks, Cursor agents, GitHub Copilot agent,
OpenHands ~78k★). Broadening puts Glean head-to-head with the platform owner on *their* strongest axis
(distribution). The narrow wedge — *capacity governor + local opportunity finder for Claude Max* — is
**empty**. Double down on discovery + pacing + the morning receipt; treat scheduling as commodity.

### #2 Subscription-only vs API option
**Recommendation: subscription-only stays the headline; an opt-in API mode is a *defensive hedge*, not a
growth feature.** The market splits cleanly: the tools closest to Glean are subscription-only (Routines
*rejects* API keys; biosphere-labs/Jarvis advertise "$0/no API costs"); the metered tools (Cursor,
Copilot, OpenHands BYO-key) are a different economic category. Glean's whole pitch — "consume capacity you
already paid for at zero marginal cost" — **evaporates under an API key** (pay-per-token) and steps toward
the reselling line Anthropic's ToS prohibits (which Glean deliberately avoids).
- **The load-bearing exogenous risk:** Anthropic *paused* (did not cancel) a 2026-06-15 change that would
  move `claude -p`/Agent-SDK usage onto separate metered credits. **If un-paused, Glean's free-idle-capacity
  thesis is directly undercut.** This is a "watch weekly" item. An opt-in API mode is the *insurance* against
  that day — worth scaffolding the seam, not worth leading with.
- Coupling audit: an API path is a moderately-clean seam (~300-500 LOC behind a backend abstraction) but
  serves a *different user* (pooled org quota, no session-JSONL, different rate-limit semantics) — a distinct
  product path, not a toggle.

### #4 Claude-native vs multi-LLM
**Recommendation: stay Claude-native.** Multi-LLM is **structurally incompatible with the capacity thesis**
— that thesis depends on the specific economics of a flat Claude Max weekly window. Support arbitrary
providers and you're back to per-token billing: you've become a worse OpenHands. Multi-LLM is owned by the
metered/BYO-key camp; Anthropic shipping Routines Claude-only is the strongest signal that "stay native" is
correct for a capacity-draining tool. Coupling audit: ~6 files are Claude-coupled on the hot path
(`spawn-claude`, `classify`, `discover-jsonl`, `jsonl-extract`, `usage`, `pacing`); going multi-LLM is a
~1000-1500 LOC rewrite that would dissolve the moat. **Don't.** (If ever desired, it's a *separate product*.)

### #1 Process optimization
**Recommendation: deepen the moat here.** Current state (coupling audit): layered model routing exists
(`model-routing.ts`), but there is **no "effort"/reasoning-effort control** (that needs the API path),
execution is **strictly serial**, ranking is **pure heuristic** (`prioritize.ts`) with **no triage pass**,
and spawned sessions use a **plain rendered template — no Claude Code skills/subagents**. Highest-leverage,
on-thesis levers:
- **Per-candidate triage** (a cheap probe to score before committing full budget) — sharpens *discovery*.
- **In-run re-ranking** (re-score remaining candidates after each task as budget decays).
- **Skill reuse inside spawned sessions** (inject skill-invocation patterns at render time) — uncertain,
  needs real-spawn validation, but directly improves output quality (the moat).
- **Model/effort triage** is partly gated on the API decision (effort = API-only today).

### #3 User-input subscription week boundary
**Recommendation: build it — clear, cheap, on-thesis.** Today pacing *assumes* a Monday calendar week
(`pacing.ts` `weekStart()` hardcoded) and only learns the real reset *reactively* from the rate-limit
signal (ADR-0003). A user whose week resets, say, Saturday 03:00 is mismodeled until the first block.
~50 LOC across `config.ts` (new `pacing.week_anchor` field) + `pacing.ts` (respect it) + `runDrain.ts`
(use it as the reset fallback instead of now+60h). This directly improves the capacity-governor accuracy —
the moat.

## Platform-absorption risk (the thing to watch)

**High but partial.** Anthropic has entered the category twice (Routines + Desktop tasks). The scheduling
shell *will* keep getting absorbed. What's NOT yet touched: **local cross-project discovery** and **capacity
draining** — and Anthropic's design choices (throttling, daily caps, cloud fresh-clone with no local access)
suggest it's steering *away* from "burn all leftover capacity," which paradoxically protects Glean's wedge.
Treat the runway as **6-18 months of uncertain lead**, not a permanent moat. Two things to monitor weekly:
1. The 2026-06-15 metered-billing pause (un-pausing = thesis risk → triggers the API hedge).
2. Whether Anthropic adds *local discovery* to Desktop scheduled tasks (that's the absorption event).

## What this means for the build queue

| Item | Verdict | On-thesis? | Effort |
|------|---------|-----------|--------|
| **#3 week-anchor config** | **Build now** | Yes (capacity accuracy) | ~50 LOC |
| **wave-2: nightly pace-gated preset + morning anti-spill** | **Build now** (already designed) | Yes (capacity governor) | medium |
| **#1 per-candidate triage + in-run re-ranking** | **Build** (next) | Yes (discovery depth) | ~150 LOC |
| **#1 skill reuse in spawned sessions** | Spike (validate first) | Yes (output quality) | uncertain |
| **#2 opt-in API mode** | **Scaffold the seam** as a hedge; don't lead | Defensive only | ~300-500 LOC |
| **#4 multi-LLM** | **Don't** (separate product) | No (dissolves moat) | ~1000-1500 LOC |
| **npm audit** | Safe-fix js-yaml now; defer the 2 major dev-tooling bumps | hygiene (dev-only, 0 user exposure) | small |

## Sources
- Competitive research: `docs/strategy/2026-06-22-competitive-landscape.md` (full report).
- Codebase coupling audit: captured in the build-task descriptions + this memo's per-question sections.
