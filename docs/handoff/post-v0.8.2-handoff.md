# Post-v0.8.2 handoff — what's next after drain robustness shipped

> Self-contained handoff so a **fresh session** can pick up cold. Everything needed is here or linked.

**As of:** 2026-06-02. `main` is at **v0.8.3**, published to npm as `@jonny-boy9000/glean@0.8.3`
(merge `7e08e3a`/PR #14, tag `v0.8.3` — a patch fixing the `schedule status`/`disable` query, found
in live validation). Built on v0.8.0 drain core + v0.8.1 UX polish + v0.8.2 drain robustness, all
shipped + published. 406 tests + 2 documented skips. The drain engine is feature-complete for now;
what remains is **validation in the wild** (now in motion) and **distribution/adoption**.

> **🟢 LIVE VALIDATION STATUS (2026-06-02).** First real `glean run` (4 tasks, 0 failed) + a `--drain`
> tick both succeeded against real `claude -p` on the logged-in Windows machine. The unattended drain
> is **scheduled and armed** (`glean schedule enable` → `\Glean\Drain`, fires **Thu 2026-06-04 18:00**).
> So the ADR-0001 gate below is now **waiting on a real weekly-cap hit, not on setup** — the scheduled
> drain runs unattended and the BLOCK-CAPTURE tripwire grabs the block automatically. Two live findings:
> (1) the schedule-status bug → fixed in v0.8.3; (2) **`fetch-docs` degrades under the deny-list**
> (context7/WebFetch/WebSearch declined in the spawned session) → roadmap item.

## Read first (orient a cold session)
- `CLAUDE.md` — load-bearing constraints (do not violate) + current state. Read the new
  **"Decision records & assumptions"** section: load-bearing/unverified decisions live in
  `docs/decisions/` as ADRs and are tagged at the code site (`ASSUMPTION[ADR-NNNN]`).
- `docs/PROJECT-MAP.md` — **the index of where everything lives**, across all three trees (the repo,
  the machine-local gstack design store at `%USERPROFILE%\.gstack\projects\Jonny-boy9000-glean\`,
  and the `~/glean` runtime). Keep it current on any layout change.
- `docs/ROADMAP.md` — planned-work source of truth ("Up next" + "Tracked backlog").
- `docs/decisions/0001-rate-limit-signal-source.md` — **ADR-0001**, the one open load-bearing
  assumption (see item 1 below).

## The single highest-value next item — close ADR-0001 (validation gate)

**What:** Do ONE real overnight/weekend `glean run --drain` against a live project, let it actually
trip the weekly rate limit, and capture the **real hard-block signal**.

**Why it matters:** This is the single biggest correctness risk left in the drain. Per ADR-0001,
every `rate_limit_event` glean has ever captured is a **warning** (`status: allowed` /
`allowed_warning`) from runs that *completed*. The actual **block** shape — what `claude -p` emits
when it genuinely cannot proceed (a `rate_limit_event` with a non-`allowed` status? an error
`result`? specific stderr?) — has **never been observed**. So `classify.ts`'s stderr block detector
(`executor.ts:RATE_LIMIT_RE`) is an honest *guess*, tagged `ASSUMPTION[ADR-0001] UNVERIFIED`.

**This gate now closes itself.** v0.8.2 shipped a **self-capturing tripwire**: the first time a
spawn is flagged rate-limited, `executor.ts` dumps the raw stderr + last stream-json messages to
`~/glean/logs/<run>/<task>.BLOCK-CAPTURE.txt`. So the moment a real block happens, the missing
shape is on disk — no manual repro needed.

**Needs user action** (a session can't trip a real weekly cap — it takes hours/days of real usage).
The user runs the live drain; a later session does the small code follow-up.

**When a real block is captured, the follow-up (small, ~1-2h):**
1. Copy the captured `BLOCK-CAPTURE.txt` (redacted) into `test/fixtures/captured-rate-limit/` as a
   real-block fixture.
2. Make `classify.ts` parse the verified block shape (the `rateLimitType` weekly value — likely
   `seven_day` — and the blocked `status` value). Keep the stderr regex as fallback.
3. Un-skip the ADR-0001 tripwire test in `src/lib/classify.test.ts` and assert against the fixture.
4. **Supersede ADR-0001** (write ADR-0002 or flip 0001's Status to Accepted with the verified
   values); update the `ASSUMPTION[ADR-0001]` tags in `classify.ts` + `executor.ts`.
5. Optional: wire `rate_limit_event.resetsAt` into the anti-spill margin (the deferred post-merge
   follow-on — `runDrain` currently uses only `last_observed_weekly_reset`).

## Other candidate next work (from `docs/ROADMAP.md`)

Pick based on what the user wants to optimize for — *validation/adoption* vs *more engine*:

- **Launch + marketing (adoption).** `docs/launch/LAUNCH-PLAN.md` + `docs/launch/RUNBOOK-stages-1-3.md`
  are written and venue-researched (r/ClaudeAI "Built with Claude" megathread, the Claude Discord
  `#Built-With-Claude` board, Show HN). **The #1 missing asset is the morning-receipt demo GIF** —
  the biggest conversion lever, and it needs the user to record it (README has `<!-- TODO -->`
  placeholders). Do NOT post anything without the user.
- **Real-repo dogfooding of `draft-impl`** (ROADMAP Up-next #3) — point the drain at real projects
  with real TODOs, collect `glean rate` verdicts over time to turn one datapoint into a trend.
  Watch for the `tests: none` (deps-missing worktree) case on real Node repos.
- **API-key fallback when Pro/Max rate-limits** (ROADMAP Up-next #2, ~75 LOC) — fall back to
  `ANTHROPIC_API_KEY` *only if set* for the rest of the budget. Note: this is the one place the
  "subscription-auth only" constraint is intentionally relaxed, and only when the user opts in by
  setting the env var. Sequence it with/after the drain work (overlaps the signal handling).
- **Hygiene** (bundle into any release): `.gitattributes` already added; stale SHA refs in
  `docs/open-work/03-dogfood-results.md`; optional `docs/superpowers/` → `docs/specs/`+`docs/plans/`
  rename; verify GitHub Discussions is enabled (README CTA points at it).

## Load-bearing constraints (from CLAUDE.md — non-negotiable, unchanged)
Subscription-auth only (no API key in the core path — the API-key-fallback item above is the sole
opt-in exception); read-only against the user's `main` checkout (drafts to `prep/glean-*` worktrees,
never push/merge); deny-list on **every** `claude -p` spawn; default `max_parallel=1`; Windows-first;
atomic `state/budget.json`; **the bare `glean run` path stays byte-identical** (additive + gated on
drain state). And the new discipline: **a finding that overturns a prior decision is a hypothesis to
disprove, not a conclusion** — verify the negative case before asserting (this is exactly how the
ADR-0001 over-claim got caught).

## Reusable orchestration prompt
For a buildable roadmap item, the ready-to-paste kickoff that drives the gstack pipeline +
Superpowers subagents (the pattern below) lives at
[`ORCHESTRATION-PROMPT.md`](./ORCHESTRATION-PROMPT.md) — fill in `<TASK>` and paste it as a fresh
session's first message. (Not for ADR-0001 or launch — those have their own prompts in this file.)

## How this v0.8.2 was built (the working pattern, for reference)
office-hours (design + adversarial review) → plan-eng-review (architecture + per-lane test plan) →
superpowers `subagent-driven-development` with **parallel worktree-isolated TDD lanes** (split by
disjoint file sets so they merge clean) → per-lane spec+quality reviews → final whole-implementation
review → `/ship`. The gstack design docs + eng-review test plans are mirrored into `docs/design/`
each release (clone-portable).

---

## Kickoff prompt — close ADR-0001 after a real block is captured (paste into a fresh session)

```
A real claude -p rate-limit BLOCK was captured during a live `glean run --drain`. Close ADR-0001.
Find the capture at ~/glean/logs/<run>/<task>.BLOCK-CAPTURE.txt (the self-capturing tripwire from
v0.8.2). Read docs/decisions/0001-rate-limit-signal-source.md and docs/handoff/post-v0.8.2-handoff.md
first. Then, TDD: (1) add the redacted real-block line as a fixture under
test/fixtures/captured-rate-limit/, (2) make src/lib/classify.ts parse the verified block shape
(rateLimitType weekly value + blocked status) keeping the stderr regex as fallback, (3) un-skip the
ADR-0001 tripwire test in src/lib/classify.test.ts and assert against the fixture, (4) supersede
ADR-0001 and update the ASSUMPTION[ADR-0001] tags in classify.ts + executor.ts, (5) optionally wire
rate_limit_event.resetsAt into the anti-spill margin in runDrain.ts. Keep bare `glean run`
byte-identical; honor every load-bearing constraint in CLAUDE.md. Then /ship as v0.8.3 (or a patch).
```

## Kickoff prompt — launch (paste into a fresh session, only with the user present)

```
Help me launch glean. Read docs/launch/LAUNCH-PLAN.md + docs/launch/RUNBOOK-stages-1-3.md (already
venue-researched) and README.md. The #1 blocker is the morning-receipt demo GIF — walk me through
exactly what to capture and where it goes in the README. Then prep (but do NOT post) the
rules-compliant copy for the Claude Discord #Built-With-Claude board and the r/ClaudeAI "Built with
Claude" megathread per the runbook. I post; you draft + sequence.
```
