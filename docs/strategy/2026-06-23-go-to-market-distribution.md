# Glean — Go-to-Market & Distribution Plan (2026-06-23)

> A marketing/distribution research pass: pain→message mapping, ICP, positioning, objections, channels,
> launch playbook, growth loops, metrics. Method: 9 research lanes → adversarial pressure-test per lane →
> integrated synthesis → completeness critic → gap-fill. External facts (audiences, competitor specifics,
> launch norms) verified live on 2026-06-22/23 (cutoff Jan 2026). 25 agents.
>
> **This BUILDS ON, does not replace, the existing in-repo launch artifacts:**
> [`docs/launch/LAUNCH-PLAN.md`](../launch/LAUNCH-PLAN.md) (2026-06-02, v0.8.1) +
> [`docs/launch/RUNBOOK-stages-1-3.md`](../launch/RUNBOOK-stages-1-3.md). Those already contain rules-aware,
> paste-ready per-venue copy. **The launch work is a DIFF/patch of those files, not a rewrite.** This memo
> records what the research adds, corrects, and re-prioritizes — and is grounded by the pinned strategy
> ([`2026-06-22-next-wave-strategy.md`](./2026-06-22-next-wave-strategy.md)) and the assumption audit
> ([`2026-06-23-assumption-audit.md`](./2026-06-23-assumption-audit.md)).

## TL;DR

glean has a **sharp, uncontested wedge, effectively zero distribution, and a launch plan it already wrote and
forgot.** Verified baseline today (`gh api`): **1 star, 0 forks, 0 watchers, `topics: []`, `homepage: null`,**
a stale GitHub description ("Windows-first MVP" — omits Linux beta + the dashboard), and thin npm keywords.
This is a **cold-start problem, not a funnel problem**: the first job is the first 50–100 real installs.

Five things this pass changes:
1. **Treat launch as a DIFF** of the existing `docs/launch/*` files (they already solve the megathread-comment
   route, the awesome-list issue route, the Discord security disclaimer, the GIF-as-#1-lever, the ToS
   pre-answer, the macOS gate, and the timezone math). Patch the v0.8.1→v0.10.0 staleness; don't regenerate.
2. **Reframe the headline off "leftover Friday capacity."** The loudest public 2026 pain is the *opposite* —
   capacity **starvation** ("I burn my whole quota in 1–2 days"). The durable reframe that fits **both**
   segments: *"extract value from a weekly cap you can't bank"* (no-rollover is verified). Lead with
   **discovery** ("finish the side projects that stall at the boilerplate wall"), the one wedge no
   competitor — including Anthropic's first-party Routines/Desktop tasks — touches.
3. **Owner-time budget.** git shows ~3 burst-days/week, so the "~10-day rollout" is really **~3 calendar
   weeks / ~40 person-hours.** The HN window (9am ET = 16:00 Jerusalem) sits *inside* the maintainer's peak
   hours — no schedule upheaval.
4. **Pre-commit the draft-quality gate** before the next dogfood (draft-impl keep-rate ≥33%, dossier
   keep/action ≥30%, N≥30 across ≥3 non-glean repos, judged on objective git/JSONL artifacts) so the number
   can't be tuned after seeing results.
5. **M-IDLE** — a gated experiment to *measure* whether the beachhead actually has surplus, with a decision
   rule: if near-zero, **discovery carries the headline**, not the drain.

**Honesty corrections (retained):** scope all economic copy to "capacity you'd lose **this week**," never
"free forever" (the metered-billing kill-switch is confirmed *paused*, not cancelled); fix glean's own
factually-wrong "resets Saturday" calendar copy; drop the unverified "40% routing" stat and the fabricated
"100% rollover" quote.

## Pain → message map

| User pain (verified strength) | glean capability | The message that lands |
|---|---|---|
| **"My side projects stall and die at the boilerplate wall between sessions"** (broadest, most differentiated painkiller) | `draft-impl` drafts on `prep/glean-*` + cross-project discovery surfacing the stalled TODO | **Lead with this.** "Finish the side projects that stall at the boilerplate wall — using a weekly cap you'd otherwise lose." Sidesteps the starvation controversy; it's the uncontested wedge. |
| "I burn my whole weekly quota in 1–2 days" (LOUDEST public pain — *opposite* of the old headline) | `glean usage` self-relative pacing + Sonnet/Haiku routing as a **conservation** governor | "See your pace before you torch your week." A governor on-ramp for the starved majority. **Do NOT pitch the drain to a starved user — it makes their pain worse.** |
| "Unused capacity doesn't roll over — I'm not getting the value I pay for" (directional fact verified; exact quote not) | pace-gated drain + model routing | "Extract value from a cap you can't bank." Economic *justification*, not headline. Never cite a fabricated "100%" quote; never "free forever." |
| "I re-lose context every session — Claude forgets my project" (universal, highest-frequency) | Pre-computed dossiers + `glean peek` SessionStart hook | "Never re-explain your project to Claude again." Crowded (CLAUDE.md, memory MCPs) — use as the *daily habit hook* that funnels to the differentiated drafts, not the headline. |
| "I want Claude to advance my backlog while I sleep, unattended" (MOST commoditized) | `glean schedule` + exit-and-re-enter drain | **Do NOT lead here.** Anthropic + a ~500★ scheduler own the bare "scheduled agent" job. Mention only as mechanism. |
| "AI drafts are low-quality slop I still have to review" (MOST empirically-backed objection; the existential one) | Verified test-pass gate, worktree isolation, `main` untouched, one-command review/discard | "A short list of test-passing starting points to accept or reject in seconds — not a pile of PRs." Win with a **feature** (hard test-pass suppression gate) + a **published, pre-committed** keep-rate, not copy. |
| "Is there even idle capacity to glean? I'm already maxed out" (the most fatal unexamined premise) | `glean usage` serves the starved; **M-IDLE** measures real surplus | Never assert surplus — **measure and show it** (M-IDLE), scoped to local spend. If the beachhead has near-zero surplus, discovery becomes the headline. |

## ICP & beachhead

**True ICP = the multi-repo personal-Max developer.** The README's own routing logic ("on Max plans Sonnet
has its own weekly pool") *literally assumes a Max plan* — the strongest source-independent anchor for "Max,
not Pro."

**The ICP inversion (best insight, survives scrutiny):** target **substantial-but-not-exhausted** Max users,
NOT the loud limit-crashers (who have zero leftover to drain). Honor the self-selection caveat — a dev
disciplined enough to run a cap-draining CLI is, by selection, likely a heavy user *in* the starved segment.
Anthropic states weekly limits hit "less than 5% of subscribers" (so 95%+ structurally have surplus) — **but
that surplus-rich 95% is not glean's beachhead** (the heaviest Claude Code devs running parallel/24-7 agents,
precisely the surplus-poor <5%). **Population abundance does not transfer to the target user.** Resolution:
the governor/drainer split serves both, and **M-IDLE measures which one the real beachhead is** rather than
asserting it.

**Disqualify explicitly:** enterprise/Team pooled-seat users (no personal local JSONL; pooled quota breaks
the per-user thesis); single-repo users (the cross-project wedge needs N repos — already served by free
first-party Desktop tasks).

**Segments (by reachability × fit):**
- **A — AI-tooling tinkerer / Claude power-user on Windows (BEACHHEAD).** Most reachable for ~$0, highest
  beta/Windows/CLI tolerance, most likely to hold idle Max capacity + multiple repos.
- **B — Multi-repo consultant/agency dev (PRIMARY EXPANSION).** Highest economic fit to the cross-project
  portfolio; blocked by confidentiality *fear*, not capability; often on pooled seats (partial disqualifier).
- **C — OSS maintainer.** Fits review-discipline norms; skews Pro-not-Max and macOS/Linux.
- **D — Solo founder / indie hacker.** Real surplus, but macOS-heavy — gate scheduler marketing on macOS.

Sizing beyond order-of-magnitude is not credibly knowable from public data; for a free OSS tool whose success
metric is **adoption, not revenue**, the honest move is to *measure* the beachhead (M-IDLE), not assert a TAM.

## Positioning & messaging

**Principle (settled): name the public category on the user OUTCOME, not the engine.** Retire "capacity
governor" to internal docs — "governor" implies *limiting* (opposite of the drain benefit). Use a descriptive
phrase, not a forced coinage; the *specific* public noun is still open, but the principle is firm.

**One-liner (lead; day-of-week-agnostic — replaces the README hero's "Friday"):**
> "glean finds the unfinished work across your repos and drafts a head-start on it — using the Claude Max
> capacity you already paid for but didn't use this week. Locally, your own login, no API key."

**PR-title / HN / awesome-list variant (≤80 chars, no superlatives):**
> "glean — drain idle weekly Claude Max capacity into reviewable code drafts, locally"

**Candidate taglines (span proven angles; test wedge vs pain):**
- (Wedge) "It finds your unfinished work and drafts it while your Claude limit would otherwise go to waste."
- (Pain) "You pay for a weekly Claude limit you never fully use. glean spends the leftovers on the TODOs already in your repos."
- (Trust) "A local CLI that spends your leftover Claude Max capacity on YOUR backlog — your own login, no API key, main never touched."

**vs-first-party frame (complement, not competitor — the right risk posture).** Lead the comparison on the two
axes Routines/Desktop **lack**: LOCAL cross-project discovery, and capacity economics. Carry competitor facts
with **dates/sources, not bare "verified" stamps** (these are fast-moving):
- *Claude Code Routines* (Anthropic docs + claude.com blog, research-preview, June 2026): cloud-only, draws
  from subscription, capped at **5/15/25 runs/day** (Pro/Max/Team), throttles deliberately (the opposite of
  draining), and a fresh GitHub clone never sees local JSONL/branches. **Re-check the run-cap the week of
  launch — research-preview limits change.**
- *Desktop scheduled tasks*: local but single-folder, fixed prompt, zero capacity awareness.
- Footnote: "Run glean for discovery + drain; run Routines for laptop-off cloud runs." Don't pick a fight
  with the platform owner.

**Honesty guardrails (load-bearing):** scope every economic claim to "capacity you already paid for and would
otherwise lose **this week**." Add one sentence: *"Today headless `claude -p` draws from your subscription;
Anthropic paused a change that would meter it (June 15 2026, now 'no longer happening' pending a revised plan
with promised advance notice) — glean is built to adapt if it returns (ADR-0008)."* Keep "gleaning" as
origin-story flavor **below** the literal benefit, never as the first thing a cold reader must decode.

## Objections → neutralization

| Objection | How real | Neutralization |
|---|---|---|
| "Is this against Anthropic's ToS?" | Real first-impression blocker; **decisively answerable** (Anthropic's own docs demo cron/pipe `claude -p`; the Feb-2026 crackdown targeted token-extraction *harnesses* — the opposite of glean). Pre-written in LAUNCH-PLAN. | "glean drives Anthropic's own binary — NOT a token-extraction harness. No API key, no proxying, no token reuse." Cite the dropped reselling design as proof. **But** downgrade the absolute "Yes." to a dated/conditional answer (see assumption audit #3). |
| "Is there even idle capacity to glean? I'm already maxed out" | **The most fatal unexamined objection** — now known-bimodal (surplus-rich for the 95%, scarce for the heavy <5% beachhead). | Governor/drainer split; lead with `glean usage` pacing (serves the starved) and **prove** leftover with M-IDLE measured output. Never assert surplus — *show* it, scoped to local spend. |
| "Low-quality slop I still have to review — net-negative" | **Most empirically-backed** (Copilot ~27–30% raw acceptance; arXiv "endless stream of AI slop"; Sonar 96%-don't-fully-trust). The existential one. | Win with a **feature**: hard test-pass suppression gate so the receipt only shows test-passing drafts. Publish a **pre-committed** keep-rate. Frame as "curated short list," not "pile of PRs." |
| "An unattended AI with shell access to my repos all weekend" | Deep, real (2026's defining security anxiety; 48% rank agentic AI the #1 attack vector). | Promote defense-in-depth (main untouched / deny-list / tree-kill+STOP / local-only) to top-of-README; the Discord security-disclaimer copy already exists. `--dry-run` = the trust on-ramp ("first weekend supervised, then schedule"). Show deny-list flags verbatim in every receipt. **Note:** the assumption audit found the deny-list is *not* a hard filesystem boundary — fix that before leaning too hard on this pitch. |
| "No macOS" | Structural; will be the top launch comment. **State it accurately:** manual `glean run` works on Mac TODAY — only the *scheduler* is Windows/Linux. | Surface "manual run works on Mac today; only the unattended scheduler is Windows/Linux" at the TOP of the README; dated issue #1 soliciting a Mac maintainer. **Re-classify launchd as POST-launch** (needs a physical Mac a solo Windows maintainer can't validate). Linux beta is a sufficient #2-platform story. |
| "Doesn't Anthropic Routines already do this?" | Real and partially materializing | "Anthropic ships the scheduling shell; glean ships the two things they steer away from — finding the work across all your projects, and spending only your leftover. We sit on `claude -p`, so we improve as the engine does." Name the one absorption event that would kill glean (local discovery in Desktop tasks). |
| "'tests: pass' doesn't mean the draft is correct" | Fair; the slop literature supports it. | "Machine-validated before you look, still review before merge" — a curated starting point, not a mergeable PR. Don't overclaim test-pass as correctness. |
| "Will it burn my whole weekly limit?" (loss-aversion) | Real fear; glean is best-in-class here | "The only Claude scheduler that spends your leftover, never your Monday." Lead with the pace-gated drain; expose projected weekly spend; offer a hard "never exceed X% of cap" ceiling. |
| "Solo maintainer / bus-factor" | Real for an unattended tool | MIT + public + auditable + no network egress beyond Anthropic; surface the 801-test suite + ADR discipline; "pin your version"; be honest it's a solo project. |

**Critical interaction (one designed flow, not two bullets):** the test-pass suppression gate + the
`base_branch` gate together risk an **empty receipt** for the (likely majority) first-run user who set neither.
The "curated short list" collapses to "nothing" on the run that decides retention. **Solve jointly:**
auto-detect the default branch on first run (per-candidate resolution already ships — executor test F5) +
**nudge-to-unlock** draft-impl (do NOT auto-run it — a confidently-wrong first draft = permanent churn) + a
graceful **never-blank receipt** ("draft-impl OFF — here are your dossiers + one command to unlock code drafts").

## Channels (ranked by audience-fit / effort; TIER-1 carries the launch)

Most of this is **already paste-ready in `docs/launch/LAUNCH-PLAN.md` §3.3 (copy A–F) + RUNBOOK** — patch,
don't regenerate.

**TIER-1 (time-critical, presence-heavy):**
1. **Claude Discord `#Built-With-Claude` — P0, low effort (soft-launch #0).** Rules-compliant copy with the
   mandatory security/data disclaimer already exists (RUNBOOK Stage 2). Lowest stakes, fastest feedback.
   *Patch:* 406→801 tests, v0.8.1→v0.10.0, add the dashboard screenshot.
2. **r/ClaudeAI "Built with Claude" Showcase MEGATHREAD — P0, low effort (soft-launch #1).** The sanctioned
   route is a **comment in the standing megathread, NOT a standalone post** (RUNBOOK Stage 3). *Patch:* bump
   counts/version; **manually re-confirm the megathread permalink hasn't rotated** (Reddit blocks automated
   fetch — eyeball it on the day).
3. **Show HN — P1 (NOT the centerpiece), medium effort.** Copy C exists. Verified base rate: 50 points = top
   ~6% of Show HN; ~1.4 stars/upvote in 48h; front page = 5k–30k visitors; only ~2.3% of submissions reach
   the front page. A comparable reached ~500★ off a *low-scoring* post via the install path — **do not stake
   the launch on the HN spike.** Title ≤80 chars no superlatives; Tue–Thu ~9am ET (=16:00 Jerusalem, inside
   peak hours); maker comment in minutes 0–5 with one honest limitation; never solicit votes.

**TIER-2 (evergreen, no timing pressure):**
4. **anthropics/skills "Show and tell" Discussions — P1, low effort.** Official Anthropic surface, zero
   gatekeeping, monitored by the exact audience + DevRel; durable backlink. (New vs the existing plan.)
5. **awesome-claude-code — P1, low effort, ONE-SHOT. COPY F IS NOW STALE and would be auto-closed.** Verified
   live (June 2026): title must be **`[Resource]: glean`** (the old prefix is now an auto-applied LABEL);
   submit via the **github.com UI form ONLY** (gh CLI / programmatic = auto-closed); Category **Tooling →
   "Tooling: Orchestrators"** (deliberately NOT "Usage Monitors" — dodges the ccusage cluster); repo must be
   **>1 week old**; you may have **no other open issue** in that repo; disclose **no network requests beyond
   the local `claude` CLI**. Run the repo's `evaluate-repository` self-review first.
6. **Repo-owned surfaces (npm + GitHub) — P0, low effort, zero borrowed audience — GENUINELY NEW.** Verified
   stale/empty today. *First move:* set GitHub topics (`claude, claude-code, claude-max, cli, automation,
   rate-limit, git-worktree, windows, developer-tools`), set homepage, rewrite the GitHub description to match
   the README hero (Linux beta + dashboard), expand npm keywords (`claude-max, rate-limit, capacity,
   subscription, git-worktree, task-scheduler, headless, windows`), align the npm description, and commit a
   1280×640 <1MB social-preview PNG in repo Settings. **Compounds every other channel.**
7. **dev.to / Hashnode + X — P2, evergreen.** Copy D (X) + E (dev.to) exist; `canonical_url` to the repo; X
   amplifies *after* HN. Lobste.rs only with a real account history.

**Drop / deprioritize for a solo free OSS CLI:** paid Product Hunt pushes, paid X reach, self-produced
YouTube, any "engineer a one-shot viral launch" tactic. The Simon-Willison authority-distribution model is
unavailable (no owned audience) — which is exactly why owned-repo SEO + curated lists + resharable artifacts
matter more. One concrete high-ROW SEO move the lanes flagged: a README section / blog / Reddit comment that
ranks for the exact pain queries ("Claude Max weekly limit", "Claude Code Routines daily limit").

## Launch playbook (a DIFF, staged)

**STAGE 0 — Eng freeze line + owner-time budget (NEW; top of LAUNCH-PLAN.md).**
- **SHIP-BLOCKING (green before any post):** (1) clean `npm i -g` on a fresh shell; (2) `glean run --dry-run`
  doesn't crash; (3) the morning-receipt GIF is real (recorded at v0.10.0 so it shows the dashboard/capacity
  line — spec already in §3.1); (4) the base_branch + suppression-gate interaction can't yield a blank/broken
  first receipt.
- **FROZEN UNTIL AFTER LAUNCH:** macOS launchd, the draft-quality *number* (launch FEEDS it), dev-tooling
  vuln bumps, ADR-0001 weekly-block capture. Rule: *"no item leaves the frozen bucket unless it blocks a
  stranger's first run."* Counters the #1 solo-launch failure mode (over-build, under-distribute).
- **Owner-time budget: ~40 person-hours over ~3 calendar weeks** at ~3 burst-days/week. Wk1 = ship-blocking
  eng + GIF (~12h); Wk2 = Discord + r/ClaudeAI + fix-loop (~10h, two ~4h presence blocks); Wk3 = Show HN +
  awesome-claude-code + X + retro (~10h, one ~4h HN block); ~8h slack. Pin presence events to **16:00–20:00
  Jerusalem**.

**PHASE 0 — Correctness + cold-start patches (blocks everything).** Fix the factually-wrong calendar copy
(README "resets Saturday morning" + "Friday" hero → day-agnostic; the window is per-user/first-prompt-anchored
and glean's own scheduler defaults to Thursday for the maintainer). Patch all v0.10.0 staleness in one pass
(406→801 tests, v0.8.1→v0.10.0, reconcile "first overnight run pending" vs "ran live 2026-06-11" into one
honesty line, add the dashboard/Linux-beta/`glean usage`/Sonnet-routing surfaces). Do the repo/npm
discoverability hygiene. Correct awesome-claude-code copy F. Promote the safety model + "Is this allowed?"
above the fold.

**PHASE 1 — Two proof assets (load-bearing).** Record the GIF at v0.10.0 per the existing §3.1 spec.
Publish the **quantified dogfood number — GATED on the pre-committed bar** (below). If keep-rate misses the
bar, **fix quality before launching** — do not launch a weak number.

**GO/NO-GO GATE before Show HN:** (1) macOS story front-and-centre (manual-run note + dated issue #1; the
launchd port itself is *frozen*, not gated); (2) a real keep-rate number exists OR is honestly labeled
"insufficient evidence, N too low"; (3) metered-billing **re-checked the week of launch** (paused as of
June 2026).

**PHASE 2 — Quiet soft-launch (Wk2; RUNBOOK Stages 1–3).** Discord (copy A) → r/ClaudeAI megathread comment
(copy B/Stage 3). Add to the drain-report template: "weekly-cap signal fired this week? (y/n)" + "paste
`glean usage --json`" (feeds M-IDLE). Harvest objections + 1–3 quotable reactions.

**PHASE 3 — Loud launch (Wk3, one shot).** Show HN (copy C), Tue–Thu 16:00 Jerusalem, maker comment + one
honest limitation pre-written. Same-week canonical blog (copy E) cross-posted. Submit the corrected
awesome-claude-code issue (async).

**PHASE 4 — Long tail.** anthropics/skills Show-and-tell, dev.to, X. Triage "good first issue" labels. Run a
fresh-machine cold-install dry-run **before** the spike (prereqs are heavy: Node 20+, logged-in `claude` on
PATH, git, and base_branch+test_command for the hero feature).

**Contingency (metered-billing kill-switch — a real playbook).** If Anthropic un-pauses metered `claude -p`
on/near launch day: (1) **POSTPONE the loud Show HN** (its premise is publicly undercut); soft channels can
proceed on the discovery framing. (2) Re-anchor the headline on billing-independent **discovery** value with a
pre-written honest in-thread response. (3) Point to the ADR-0008 API seam as the hedge. Weekly pre-launch check.

## Growth loops, activation & retention

**Activation aha (strong, but at the END of a fragile funnel):** the first `glean morning` receipt showing a
real `prep/glean-*` draft branch with PASSING tests and `main` untouched. Funnel: discover → `npm i -g` →
(prereqs) → configure base_branch/test_command → first run → wait a window → aha → schedule → retain.

**Drop-offs (priority order):**
1. **base_branch gate + suppression gate = EMPTY RECEIPT** (the #1 activation killer). Fix as the single
   designed flow above (auto-detect + nudge-to-unlock + never-blank receipt). Dossiers-only is the *safer*
   first experience.
2. **Negative-aha / confidently-wrong first draft.** For a trust-dependent unattended tool, one wrong first
   draft outweighs many good ones. Design the FIRST draft: lowest-risk candidate, "research-only — do not
   merge" marker on weak drafts, supervised first run before scheduling.
3. **Long time-to-aha.** A real drain aha needs a scheduled weekend. Make `glean usage` the **zero-config
   first command** — an instant, true, personal "you have idle capacity" micro-aha that earns the heavier
   setup. ("ccusage shows the waste; glean USES it.")
4. **macOS lockout** at the top of the funnel (manual run works; scheduler doesn't).
5. **Empty/thin receipt** on a clean repo — surface "no new candidates — add another project," not a blank INDEX.

**Viral loops:**
- **RECEIPT.md attribution footer (highest-ROI, lowest-effort).** `glean morning --md` is already a natural
  share artifact (paste into PR/Slack) but leaks zero attribution. Add a tasteful, opt-out-able line:
  *"Drafted overnight by glean (`npm i -g @jonny-boy9000/glean`) — github.com/Jonny-boy9000/glean."* Turns
  existing share behavior into the only real acquisition channel.
- **The dogfood "glean wrote this" artifact** (aider-style), recurring in every release note — **conditional
  on the keep-rate clearing the gate.**
- Merged draft branches are a weak signal (deny-list correctly blocks push/PR) — a retention proxy, not a channel.

**Retention (the genuine risk, not activation):** glean decays into try-once novelty unless (a) it keeps
finding NEW high-value work weekly — surface `glean projects` at onboarding so users point it at ALL repos —
and (b) the Monday receipt has a trigger — extend `glean peek` into a "glean drafted N branches this weekend —
run `glean morning`" banner. Both use primitives that already exist.

## Metrics (no telemetry by design; cheap honest proxies)

**Capture the baseline BEFORE any change** (verified today: 1 star, 0 forks, 0 watchers, 2 issues,
`topics: []`, `homepage: null`, stale descriptions). Freeze the exact npm-search + GitHub-search position
queries for 3 target terms; re-check at 30/90 days. **Cadence:** a weekly 10-minute manual check
(stars/downloads/issue-buckets), surfaced in `glean doctor` or a pinned checklist — without a ritual the proxy
apparatus silently never happens.

**The draft-quality gate (PRE-COMMITTED — the make-or-break).** Write a one-page "Quality gate v1" under
`docs/launch/` BEFORE the next dogfood, fixing every parameter so the number can't be tuned post-hoc:
- **Two bars, never blended:** **draft-impl keep-rate ≥33%** (branch merged/cherry-picked — this bar can
  BLOCK launch); **research-dossier keep/action-rate ≥30%** (advisory). Anchors (dated/sourced): Copilot
  ~27–30% inline acceptance, ~88% of accepted chars retained; Cursor agent merge ~35% (WEAKER anchor —
  treat as directional).
- **N ≥ 30 rated outputs per type, across ≥3 distinct repos that are NOT the glean repo** (the dogfood showed
  glean flagging its own scanner strings — self-referential false positives distort keep-rate). Below N=30:
  "insufficient evidence," do not pass/fail (binomial: 30% at N=10 is ±~28pp).
- **Judge = an objective git/JSONL artifact** (branch merged/cherry-picked within 14 days; dossier still
  referenced/edited) — NOT the maintainer's in-the-moment opinion. Ship **`glean rate --report`** (trivial
  query over existing columns) so the gate is computed from telemetry, not a glowing writeup.
- This is **not** SWE-bench (80–95% on curated tasks with hidden tests — a different event). Below bar → fix
  discovery/prioritizer/templates, don't abandon the metric.

**M-IDLE — the premise-validation milestone (gated, with a decision rule).** From ≥20 consenting power-user
weeks, publish (a) the fraction of weeks the weekly-cap signal NEVER fired (an honest hard floor on idle
capacity) and (b) the end-of-week pace-ratio distribution. **Stratify by intensity** (surplus is bimodal).
State the blind-spot caveat (claude.ai/Cowork/other-machine usage is invisible locally, so the floor
over-states true surplus). **Decision rule: if median measured surplus on the beachhead is near zero, demote
the drain headline and lead with discovery.** Seed it now via the drain-report template before any opt-in
`glean usage --share` export is built.

**Adoption (the real success metric for free OSS):** at 30 days, ~50–100 npm installs + a **wide 30–200 star
band** (verified comparables are bimodal — ~1.4 stars/upvote on HN, but a ~500★ outcome came off a low-scoring
post via the install path). Set the expectation so a median outcome isn't misread as failure.
Downloads-to-stars trending up = repeat use, which matters more than raw stars.

**Risk watch (weekly, in `glean doctor`/dashboard):** metered-billing un-pause; whether Anthropic adds local
discovery to Desktop tasks (the absorption event); the Routines run-cap (a research-preview figure that drifts).

## What the pressure-test corrected (honesty corrections, retained)

- **Drop the unverified "40% routing reduction" stat** and the **fabricated "100% rollover" quote** — both
  were flagged as overclaims; no-rollover is *directionally* verified, the exact wording is not.
- **Fix glean's own factually-wrong "resets Saturday" calendar copy** — the window is per-user/first-prompt-
  anchored; this is a correctness bug in the marketing, not just positioning.
- **Don't over-stamp fast-moving first-party competitor specifics as "verified"** — carry dates + sources;
  the Routines 5/15/25 run-cap is a research-preview figure to re-check at launch.
- **Scope all economic copy to "this week," never "free forever"** — the metered-billing kill-switch is
  confirmed *paused, not cancelled*.
