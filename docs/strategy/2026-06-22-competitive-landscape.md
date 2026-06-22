# Glean — Competitive Landscape (2026-06)

> Output of a verified research pass (21 agents across 6 search angles → 42 unique candidates → 14
> deep-verified). Auth/scheduling/LLM claims were fetched-and-confirmed, not taken from search snippets.
> Companion to [`2026-06-22-next-wave-strategy.md`](./2026-06-22-next-wave-strategy.md).

## 1. Bottom line

Nothing does exactly what Glean does — the specific combination is genuinely novel — but the scaffolding
around it is being commoditized fast, including by Anthropic itself. No verified tool combines all five of
Glean's defining traits: (1) scheduled + (2) headless + (3) consuming *idle leftover weekly subscription
capacity* via an exit-and-re-enter drain, (4) *autonomous cross-project discovery* of unfinished work, and
(5) strictly no-API-key / read-only-against-main + morning receipt. Every competitor matches a subset but
breaks on the **capacity-drain thesis** and/or the **autonomous-discovery layer** — those two together are
Glean's uncontested wedge. Closest: Anthropic's own **Claude Code Routines** (outcome/auth axis) and
**Claude Code Desktop scheduled tasks** (local-scheduling axis) — both first-party and distribution-advantaged.

## 2. The map (closest first; verified tools only)

| Tool | What it does | Auth | Scheduled? | LLM(s) | Overlap |
|---|---|---|---|---|---|
| **Claude Code Routines** (Anthropic) | Saved prompt+repos → autonomous cloud sessions on `claude/` branches | Subscription only (rejects API key) | Yes — cloud, laptop-off, 1h-min | Claude | **High** |
| **Claude Code Desktop scheduled tasks** (Anthropic) | Local scheduled fresh session; worktree toggle; catch-up; single folder | Subscription (app) | Yes — local, app must run | Claude | **High** |
| **jshchnz/claude-code-scheduler** (~500★) | NL → OS-scheduled `claude -p`; worktree on `claude-task/*` + push | Subscription (inherited) | Yes — launchd/cron/**Task Scheduler** | Claude | **Med-High** |
| **sleepwalker** | Overnight "fleet manager": ~15 routines + dashboard + "Morning Queue" | Mixed (sub + bearer-token API) | Yes — launchd + cloud | Multi | **Med-High** |
| **biosphere-labs/claude-code-scheduler** | Headless cron daemon running hand-authored recipes | Subscription only (explicit) | Yes — own daemon | Claude | **Med** |
| **Jarvis** (Ramsbaby) | Self-healing ops platform; secondary autonomous-coding loop | Subscription only ("$0") | Yes — 40+ cron jobs | Claude (+Ollama embeds) | **Med** |
| **Ralph Wiggum** (technique/plugin) | Loops Claude on ONE prompt until "DONE"; Stop-hook re-feed | Both (inherits) | Manual launch, no scheduler | Claude | **Med (complement)** |
| **Outworked** ("Cozy Office") | Electron office of AI employees; orchestrator + cron skill | Subscription (Claude Code) | Yes but supervised | Claude | **Low-Med** |
| **OpenHands** (~78k★) | Self-hosted agent control center; issues; schedule/webhook | **API-key / BYO** | Yes | Multi (LiteLLM) | **Low-Med (mechanism)** |
| **Cursor Cloud/Background Agents** | On-demand cloud VM → branch → PR | Hybrid, **metered** | No true scheduler | Multi | **Low** |
| **GitHub Copilot coding agent** | Cloud agent on issues/@mentions → PR | Subscription + metered overage | Partial | Multi | **Low** |

## 3. Closest competitors — where Glean is differentiated vs exposed

- **Claude Code Routines (the headline threat).** Matches Glean on outcome + auth (more subscription-locked
  than Glean), runs in Anthropic's cloud (laptop-off — strictly stronger). But inverts two pillars: **no
  discovery** (you author the prompt) and **no capacity thesis** (it throttles to *avoid* runaway use). No
  local file access, so it never sees local JSONL/branches/uncommitted work. Glean's *local discovery +
  capacity economics* survives; the bare "scheduled agent" mechanic does not.
- **Desktop scheduled tasks (closest on Glean's own local turf).** Subsumes the plumbing (scheduled local
  session, worktree, catch-up, self-reschedule — a direct parallel to Glean's ADR-0004 sleep-proofing).
  Glean still wins on portfolio (cross-project), discovery/ranking, capacity awareness, and the aggregated
  receipt. Strongest argument that Glean should NOT chase the generic-nightly-agent direction.
- **jshchnz/claude-code-scheduler (closest community tool; same Windows-first substrate).** Real traction
  (~500★) but a *manual cron-for-Claude* — it's the execution substrate Glean's value layer sits on, not a
  substitute. Code-static since 2026-01.
- **sleepwalker (mirror of the "broaden" path).** "Morning Queue" ≈ Glean's receipt; green/yellow/red gates
  ≈ Glean's read-only discipline. But it's the *general-ops nightly fleet* (email/cleanup/calendar),
  macOS-only, multi-LLM, 0★ alpha, **no capacity thesis**. A design reference for the broad path, not a threat.

## 4. Platform-absorption risk

**High and already materializing — but partial.** Anthropic entered the category twice (Routines cloud +
Desktop local). The generic scheduled-agent mechanic is commoditized and will keep getting cheaper/free.
**Not yet absorbed:** autonomous *local* cross-project discovery (JSONL + on-disk repos + ROADMAP, ranked)
and idle-weekly-capacity *draining*. Anthropic's choices (throttling, daily caps, cloud fresh-clone with no
local access) suggest it's steering *away* from "burn leftover capacity" — which protects Glean's wedge.
Runway: **6-18 months of uncertain lead**, not permanent. Watch: (1) the 2026-06-15 metered-billing pause
un-pausing; (2) Anthropic adding local discovery to Desktop tasks.

## 5. Honest gaps
- The **2026-06-15 Anthropic billing pause** is the load-bearing uncertainty — headless `claude -p`
  *currently* still draws from subscription limits, but un-pausing metered Agent-SDK credits would directly
  invalidate the thesis. Watch weekly.
- Whether first-party scheduled runs will gain self-selecting/discovery behavior is unknowable from current
  docs — the key absorption variable, no signal either way yet.
- Unverified third-party figures: OpenHands SWE-bench %, Cursor "~30-35% of merged PRs from agents."
- Not deep-checked (possible closer matches on one axis): Devin, Factory/Droids, MindStudio scheduled agents,
  ccswarm, claude-mcp-scheduler, amux overnight-agents guide.
