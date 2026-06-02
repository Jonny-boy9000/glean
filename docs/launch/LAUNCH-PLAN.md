# glean — Launch & Marketing Plan

> Goal: get the right people (Claude Code / Pro/Max power users) to **actually install glean, run a drain, and tell us what they kept vs. discarded**. Real usage signal, not vanity metrics. We optimize for installs → first `glean run` → first `glean morning` → first `glean rate`.
>
> Status when written: v0.8.1 published to npm (`@jonny-boy9000/glean`). Windows-first. Early. One real overnight drain run still pending. This plan reflects that honestly — we do not fake an overnight result in any asset.
>
> Owner: Jonny-boy9000. Generated via `/office-hours` (builder mode). Date: 2026-06-02.

---

## 0. The one rule for this launch

This audience can smell a launch that overclaims. glean's credibility *is* its honesty (the README literally documents the rejected token-reselling design and the pending overnight run). So every post leads with the honest frame: **"early, Windows-first, here's exactly what it does and what it doesn't yet."** That honesty is the differentiator against the wave of "AI does your work while you sleep" hype. Lean into it.

We are not chasing upvotes. We are chasing **ten people who run it on a real repo and open an issue.** A 40-upvote Show HN with 6 thoughtful "here's what broke / here's what I kept" comments beats a 400-upvote thread with zero installs.

---

## 1. Positioning

### One-line hook
**glean turns the Claude capacity you'd otherwise waste before the weekly reset into reviewable draft branches and research dossiers — drained unattended, waiting for you Monday morning.**

Shorter variants (use per venue character budget):
- **"Your Pro/Max weekly limit doesn't roll over. glean spends the leftover on draft branches + dossiers while you're away."**
- **"A CLI that drains your idle Claude weekly capacity into a Monday-morning head-start."**

### 3-sentence pitch (for the Claude Code / Max power-user crowd — assumes they already get subscription auth + weekly limits)
> Your Pro/Max weekly window resets every Saturday and the capacity you didn't spend is just gone. glean is a Windows CLI that, in that idle tail, spawns its own headless `claude -p` sessions to do speculative prep on your own repos — drafting code into throwaway `git worktree` branches (never touching `main`), writing research dossiers, pre-fetching docs — and you point Windows Task Scheduler at it so it drains the whole weekend's leftover unattended, pausing at each 5-hour wall and resuming until the weekly cap fires. Monday you run `glean morning` and get a receipt: each draft branch with a verified `tests: pass`, the exact command to review it, and an honest capacity line. It's your own subscription driving your own `claude` CLI on a schedule — no API key, no proxying, nothing pushed.

### Honesty boilerplate (paste near the top of every post)
> Heads up: **glean is early and Windows-first today.** The scheduler is Windows Task Scheduler only (macOS/Linux is the [top tracked issue](https://github.com/Jonny-boy9000/glean/issues/1)). The single-run + draft-branch path is dogfooded and tested (352 tests); the unattended multi-day weekend *drain* is built but hasn't had its first real overnight validation run in the wild yet. I'm posting partly to find people who'll run it and tell me what breaks.

### What makes it land with this crowd (use as talking points in comments)
- **"Is this allowed?" is pre-answered.** It drives your own logged-in CLI, same `claude -p` calls you could type by hand. No key, no resale. (The rejected resale design is documented as dropped.)
- **Safety is concrete, not vibes.** Drafts go to `prep/glean-*` branches in isolated worktrees; every spawned session runs under a `--disallowedTools` deny-list blocking `git push`/`checkout`/`reset`/`gh pr` mutations; `main` is never checked out.
- **It already measures its own usefulness.** `glean rate <id> kept|discarded|actioned` — we ship the honesty metric, we don't hide behind "it's magic."

---

## 2. Target venues, ranked

Ranked by **density of the exact audience × ease of getting real install + feedback signal.** Reach alone is deprioritized; a venue where someone will actually `npm i` and reply is worth more than a big drive-by crowd.

> Timezone note: the bulk of this audience is US-centric with a strong EU tail. Times below are US Eastern (ET) with PT in parens. Convert from your local Asia/Jerusalem (ET+7 in summer) — e.g. 9:00am ET ≈ 4:00pm Jerusalem.

| # | Venue | Why it's first-choice | Effort | Best day/time |
|---|---|---|---|---|
| 1 | **r/ClaudeAI** | Highest concentration of people who already live the weekly-limit pain. Forgiving of "early." | Low | Tue–Thu, 8–11am ET (5–8am PT) |
| 2 | **Claude Discord (Showcase)** | 100k+ members, real-time back-and-forth, fastest feedback loop. Soft-launch sandbox. | Low | Tue–Thu, 10am–2pm ET |
| 3 | **Hacker News — Show HN** | Biggest reach + the most useful critical feedback if it lands. The main event. | Med | Tue–Thu, 9–11am ET (see §2.3 for the weekend-data alternative) |
| 4 | **awesome-claude-code (GitHub list)** | Durable, evergreen discovery by the exact buyer. Submit once, keeps paying. | Low | Anytime (async PR/issue) |
| 5 | **X / Twitter (build-in-public)** | Where the Claude Code dev circle congregates; the GIF travels here. | Low | Tue–Thu, 9–11am ET or 1–3pm ET |
| 6 | **dev.to** | Evergreen long-form writeup; weak live feedback but good SEO + canonical back to repo. | Med | Tue–Thu morning ET |
| 7 | **Lobste.rs** | Sharp technical audience, but invite-only and strict on self-promo. Only if you have an account. | Low | Tue–Thu morning ET |

### 2.1 r/ClaudeAI — soft launch #1
- **Norms / rules:** Subreddit is explicitly for Claude + Claude Code discussion and has a dedicated **"Self-Promotion" post category/flair** — use it; do not post a tool without it. General Reddit rule of thumb the mods enforce: be transparent you're the author, and the post must give value beyond "go install my thing." Check the sidebar/pinned rules before posting (Reddit blocks automated rule fetch; verify manually) — some weeks have a dedicated self-promo megathread; if so, post there first.
- **Format that works here:** A "I built this to scratch my own itch" story post, the GIF, an honest caveats line, and a genuine question to the room ("does anyone else feel the Friday waste? what would you want it to draft first?"). Ask for feedback, not stars.
- **Best time:** Tue–Thu, 8–11am ET. Be present in the thread for the first 3–4 hours to answer every comment.

### 2.2 Claude Discord — soft launch #0 (do this first)
- **Where:** The official Claude community Discord (100k+ members). Post in the project-showcase / "what are you building" channel, not general chat. Read the channel's pinned rules first.
- **Why first:** Lowest stakes, fastest iteration. Feedback here sharpens the Reddit post, which sharpens the Show HN. Treat it as a focus group.
- **Format:** Short message + GIF + repo link + one question. Respond fast, DM willing testers, offer to walk them through setup.
- **Best time:** Tue–Thu midday ET when the channel is liveliest.

### 2.3 Hacker News — Show HN (the main event)
- **Rules (from the official Show HN guidelines):**
  - Title **must** start with `Show HN:` and it must be something people can run/try. A CLI on npm qualifies cleanly. ✅
  - No signup/email gate to try it (npm install — fine).
  - "Early-stage work is acceptable if functional." Our honesty frame fits the guideline exactly.
  - You **must be around to answer** — block 3–4 hours after posting. This is non-negotiable on HN.
  - Add a first comment from yourself with context (the backstory, the constraints, what you want feedback on). This is expected and is where you set the honest frame.
  - Don't editorialize the title with hype. Plain and concrete wins.
- **Best day/time — two schools, pick by goal:**
  - **Recommended for us (feedback goal): Tue, Wed, or Thu, ~9:00am ET (6:00am PT).** Catches the US morning + EU afternoon, and the thread stays alive through US working hours so you get real back-and-forth — which is what we're optimizing for.
  - **Alternative (max front-page odds): Sunday, early UTC (Sat evening US) or Sun midday UTC.** Recent data shows weekends running 20–30% higher "breakout" rate (Sunday 0–2 UTC ≈ 15.7%). Lower competition. Downside: a weekend thread gets fewer working-hours replies, so slightly worse for deep feedback.
  - Decision: **go Tuesday 9am ET.** We want comments more than karma.
- **Reposting:** HN allows a resubmit once the project is genuinely ready if a first attempt sank without traction. Don't spam it; one good shot.

### 2.4 awesome-claude-code (curated GitHub list)
- **Submission path (important, it changed):** **Do NOT open a PR yourself** — the repo's workflow is to **open a GitHub Issue labeled `resource-submission`** (the maintainer's automation handles the PR). Read `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` first.
- **Category:** "applications" / "tooling" for Claude Code.
- **Why:** Evergreen. People browsing that list are exactly our buyer and arrive with intent. Costs 10 minutes, pays for months.

### 2.5 X / Twitter
- **Norms:** Build-in-public is the native mode. Lead with the GIF (autoplay MP4), one tight sentence, repo link in a reply (not the main tweet, to avoid link-suppression). Thread it: tweet 1 = hook + GIF, tweet 2 = "how it stays safe" (deny-list, worktrees), tweet 3 = "it's early + Windows-first, looking for testers" + link.
- **Amplify, don't originate:** Post this *after* the Show HN so you can quote-tweet "currently on the HN front page" if it lands, or just "shipped this" if not.
- **Best time:** Tue–Thu 9–11am ET or the 1–3pm ET second window.

### 2.6 dev.to
- **Norms:** Long-form is welcome. Use a `#claude` / `#cli` / `#showdev` tag set. If you also blog it elsewhere, set the **canonical URL** to the original so you don't split SEO. `#showdev` is the dev.to equivalent of Show HN for "I made this."
- **Use it for:** the deeper "how the unattended drain works (exit-and-re-enter across the 5-hour wall)" writeup — the architecture story this crowd enjoys. Links back to the repo.
- **Feedback value:** lower than Reddit/HN/Discord, but it's evergreen and ranks.

### 2.7 Lobste.rs
- **Rules:** Invite-only (need an existing member to invite you). Self-promo must be **< 25% of your stories/comments**; tag your own submission with the **`show`** tag and the **`authored`** tag for transparency. They are actively hostile to LLM-generated submission text and to "write-only marketing." Only post if you have a real account with history, otherwise skip — a cold self-promo here backfires.
- **If eligible:** a single, plainly-worded `show`-tagged post. Same honest frame.

---

## 3. Launch assets

### 3.1 The morning-receipt GIF — #1 conversion lever (record this first)

Everything else waits on this. The GIF is what makes someone go "oh, I want that Monday feeling." It must show the **payoff**, fast, and it must be **real output** (no faked overnight result).

**What to capture (the hero shot): a real `glean morning` receipt.**

Recommended structure — a 3-beat, ~15–20s loop:

1. **Beat 1 (2–3s): the setup, told in one line.** A terminal showing the single command that armed it:
   ```
   > glean schedule enable --project C:\my-app
   drain scheduled: Thursday 18:00 (detected from timezone Asia/Jerusalem)
   ```
   Caption overlay: *"Friday: armed it once."* (This frames the unattended angle honestly without faking a multi-day run.)
2. **Beat 2 (1s): a hard cut + caption** — *"Monday morning:"* (black frame or title card).
3. **Beat 3 (10–14s, the star): `glean morning` running and its receipt.** Capture the real receipt output:
   - the draft branch line with its **diff stat**,
   - the **verified `tests: pass`**,
   - the **"main untouched"** / review-command line (`cd` into the worktree),
   - the dossier list,
   - the honest **capacity line** at the bottom.
   Let it sit on the final frame for ~2s before the loop so the `tests: pass` is readable.

**If the scheduler beat feels like it implies an unverified overnight drain,** cut Beat 1 to just `glean run --project C:\my-app` (a real single burst you've actually run) and caption it *"ran it Friday."* Honesty > polish. Demo only what's verified.

**Capture spec:**
- **Tool (Windows):** [ScreenToGif](https://www.screentogif.com/) (free, frame-level editing, exports GIF + MP4) or `terminalizer` / `asciinema` + `agg` if you want a scripted, deterministic recording. ScreenToGif is the path of least resistance on Win11.
- **Terminal:** Windows Terminal, a dark high-contrast theme, font ≥ 16pt (it'll be viewed small on mobile — legibility is everything). Hide the tab bar clutter.
- **Window size:** record at ~1200px wide, 16:9-ish. Export a **GIF under 3MB** (Reddit/GitHub inline cap territory) **and** an **MP4** (X autoplay, smaller, smoother).
- **Typing:** pre-type or use a fast, even keystroke cadence — no long pauses, no typos, no hunting. Or paste the command and just show the output scroll.
- **Hygiene:** scrub the frame for anything private — real repo names, file paths you don't want public, tokens, usernames. Use a demo repo (`C:\my-app`) if needed. No secrets on screen.
- **Where it lives:** commit it to `docs/assets/glean-morning.gif` and reference it at the top of the README (the README currently points at a static `.png` — swap in the GIF, or add it above the fold). Also keep the MP4 for X.

**Acceptance check before you ship it:** a stranger watching on mute, on a phone, for 15 seconds, can answer "what did this do for me?" → *"it drafted code + research while I was gone, and the tests already pass."* If they can't, re-cut.

### 3.2 Secondary assets
- **README is already strong** — it's the landing page. Make sure the GIF is above the fold and the "Is this allowed?" section stays prominent.
- **A 2-line `asciinema` of the dry run** (`glean run --dry-run`) showing the ranked candidate list — optional, good for the dev.to/HN technical reader who wants to see discovery before committing.
- **Pinned "Known limitations / help wanted" issue** (see §5) so every visitor sees the honest state and an on-ramp.

### 3.3 Draft post copy (ready to paste)

> Replace `[GIF]` / `[MP4]` with the asset and verify the repo URL. All copy below is written in the honest frame; don't strip the caveat lines.

---

#### A) Claude Discord (showcase channel) — soft launch #0

```
Built a thing for the weekly-limit problem we all have 👇

Your Pro/Max weekly window resets Saturday and whatever capacity you didn't spend just evaporates. `glean` is a CLI that spends that idle tail for you: it scans your repos + Claude session history for unfinished work and spawns headless `claude -p` sessions to draft code into throwaway git worktree branches (never touches main), write research dossiers, and pre-fetch docs. Point Windows Task Scheduler at it and it drains the weekend's leftover unattended. Monday you run `glean morning` and get a receipt — each draft branch with a verified `tests: pass` and the command to review it.

[GIF]

Honest status: it's early and Windows-first right now. Single-run + draft-branch path is dogfooded and tested; the unattended multi-day drain is built but hasn't had its first real overnight run in the wild — so I'm partly here to find people who'll try it and tell me what breaks.

Repo: https://github.com/Jonny-boy9000/glean  (npm: @jonny-boy9000/glean)

Question for the room: if it could pre-draft ONE thing on your repo before Monday, what would you want it to be — the top TODO, a failing test, a PR reply?
```

---

#### B) r/ClaudeAI — soft launch #1

**Flair:** Self-Promotion (required)

**Title:**
```
I built a CLI that drains my leftover weekly Claude capacity into Monday-morning draft branches (early, Windows-first)
```

**Body:**
```
Like most of you, my Pro/Max weekly window resets Saturday and by Thursday I've spent the high-value work — leaving capacity that doesn't roll over. That bugged me enough to build `glean`.

In that idle tail it spawns its own headless `claude -p` sessions to do speculative prep on my own repos:
- drafts code for my top TODO into an isolated `git worktree` on a `prep/glean-*` branch (main is never checked out, pushed, or merged)
- writes research dossiers for unfinished threads it finds in my session history + `git grep TODO/FIXME`
- pre-fetches library docs as cheap filler

Point Windows Task Scheduler at it (`glean schedule enable`) and it drains the whole weekend's leftover unattended — it pauses at each 5-hour limit, resumes when the window reopens, and stops the moment the weekly cap fires so it never spills into the new week. Monday I run `glean morning` and get a receipt of everything it did, each draft branch with a verified `tests: pass`.

[GIF]

On "is this allowed": it drives my own logged-in `claude` CLI — the same `claude -p` calls I could type by hand. No API key, no proxying. Every spawned session runs under a deny-list blocking `git push`/`checkout`/`reset`/`gh pr` mutations.

Honest caveats: it's early and Windows-first (macOS/Linux is the top tracked issue). The single-run + draft path is dogfooded and tested (352 tests). The unattended multi-day drain is built but hasn't had its first real overnight validation run yet — so genuinely looking for people to try it and report back.

Repo + install: https://github.com/Jonny-boy9000/glean  (`npm i -g @jonny-boy9000/glean`)

What would you want it to draft first on your own projects? And does anyone else actually feel the Friday-capacity waste, or is it just me?
```

---

#### C) Hacker News — Show HN

**Title (≤ 80 chars, plain, no hype):**
```
Show HN: Glean – drain leftover Claude weekly capacity into draft branches
```

**URL:** `https://github.com/Jonny-boy9000/glean`

**First comment (post immediately after submitting — this sets the frame):**
```
I'm on Claude Pro/Max. The weekly rate-limit window resets every Saturday, and capacity I don't spend by then is just gone. glean is a Windows CLI that spends that idle tail for me.

In the tail window it spawns its own headless `claude -p` sessions to do speculative prep on my own repos:
- drafts code for the top TODO into an isolated `git worktree` on a disposable `prep/glean-*` branch (main is never checked out/pushed/merged)
- writes research dossiers from unfinished threads in my ~/.claude session history + `git grep TODO/FIXME` + open PR comments
- pre-fetches library docs as cheap end-of-budget filler

`glean schedule enable` registers one Windows Scheduled Task that drains the weekend's leftover unattended: it works to the 5-hour session wall, classifies the reset horizon from stderr, persists a resume cursor, and exits — the scheduler re-launches it when the window reopens. It stops the moment the weekly cap fires so it never eats into the next week. Monday, `glean morning` prints a receipt: each draft branch with a diff stat and a verified `tests: pass`, plus the exact command to review it.

Design constraints I cared about:
- Subscription auth only, no API key — it drives the same `claude -p` you'd type by hand (an earlier design that resold tokens is documented as dropped; it'd violate Anthropic's terms).
- Read-only against your real checkouts; all speculative output is in worktrees or under ~/glean.
- Every spawned session runs with a `--disallowedTools` deny-list (no `git push`/`checkout`/`reset`, no `gh pr` mutations).

Honest status: it's early and Windows-first (macOS/Linux scheduling is the top tracked issue). 352 tests; the single-run + draft path is dogfooded. The unattended multi-day weekend drain is built but hasn't had its first real overnight run in the wild yet — I'd love for someone to try it and tell me where it breaks. The usefulness metric is built in: `glean rate <id> kept|discarded` so I can see what's actually worth keeping.

Repo: https://github.com/Jonny-boy9000/glean  ·  npm: @jonny-boy9000/glean

Happy to answer anything — especially interested in (1) whether the exit-and-re-enter drain model is the right call vs. a long-lived process, and (2) what you'd want drafted first.
```

---

#### D) X / Twitter (thread)

```
Tweet 1:
Your Claude Pro/Max weekly limit resets Saturday. Whatever you didn't spend just vanishes.

I built glean to spend that leftover for me — it drafts code branches + research dossiers while I'm away, and Monday I get a receipt with tests already passing.

[MP4]

Tweet 2:
How it stays safe:
• drafts go to throwaway prep/glean-* git worktree branches — main is never touched
• every spawned claude -p runs under a deny-list (no push, no checkout, no gh pr)
• it's your own logged-in CLI on a schedule. no API key, no proxying.

Tweet 3:
It's early and Windows-first today, and the unattended weekend "drain" hasn't had its first real overnight run in the wild — so I'm looking for people to break it.

npm i -g @jonny-boy9000/glean
https://github.com/Jonny-boy9000/glean
```

---

#### E) dev.to (long-form, after launch)

**Title:** `Spending idle Claude capacity: how glean drains a weekly rate-limit window unattended`
**Tags:** `#claude #cli #showdev #automation`
**Canonical URL:** point to the repo or your own blog if cross-posted.
**Angle:** the architecture story — the exit-and-re-enter drain across the 5-hour wall, the horizon classifier, the worktree deny-list safety model. End with the install + "it's early, try it" CTA and a link to GitHub Discussions for feedback.

---

#### F) awesome-claude-code submission (GitHub Issue, not PR)

```
Issue title: [resource-submission] glean — CLI to drain idle Claude weekly capacity into draft branches + dossiers

Body:
- Name: glean
- Repo: https://github.com/Jonny-boy9000/glean
- npm: @jonny-boy9000/glean
- Category: Applications / Tooling
- One-liner: A Windows-first CLI that spends your leftover Pro/Max weekly capacity on speculative prep — drafting code into isolated git worktree branches, writing research dossiers, pre-fetching docs — drained unattended via Windows Task Scheduler, with a `glean morning` receipt.
- License: MIT
(Read CONTRIBUTING.md + CODE_OF_CONDUCT.md; label as resource-submission per the repo's workflow.)
```

---

## 4. Sequencing — a ~10-day rollout

The point of staging is **feedback compounding**: each venue's reactions sharpen the next post. Don't fire them all at once.

**Pre-flight (Days -3 to 0) — do not launch without these:**
- [ ] Record + commit the morning-receipt GIF (§3.1). This gates everything.
- [ ] Swap the GIF into the README above the fold; keep the static PNG as fallback.
- [ ] Enable **GitHub Discussions** with the categories in §5.
- [ ] Add **issue templates** + a pinned **"Known limitations / help wanted"** issue (§5).
- [ ] Re-read the npm package: `npm i -g @jonny-boy9000/glean` works clean on a fresh machine? Node version note correct?
- [ ] Have a demo repo ready (clean paths) for the GIF and for live-walkthrough offers.

**Day 1 (Tue) — Soft launch, low stakes:**
- Post in **Claude Discord** showcase (copy A) in the morning ET.
- Sit in the thread. Collect the first round of "wait, does it…" questions. Note every point of confusion — those are README/FAQ fixes.

**Day 2 (Wed) — Fix + Reddit:**
- Apply the Discord fixes to README/FAQ + post copy.
- Post to **r/ClaudeAI** (copy B) with Self-Promotion flair, 8–11am ET. Be present 3–4 hours.
- DM/loop anyone who says "I'll try it" — your first real testers.

**Days 3–4 — Listen + harden:**
- Triage incoming issues. Fix anything that blocks a first run (install, config, first-run crash). A blocker fixed now saves the Show HN.
- Fold the sharpest Reddit phrasing into the Show HN first comment.
- Submit the **awesome-claude-code** issue (copy F) — async, no timing needed.

**Day 5 or following Tue — The main event:**
- Post **Show HN** (copy C) at ~9:00am ET on a Tue/Wed/Thu. First comment immediately. Clear your calendar for 4 hours.
- Once it's live and you can see whether it's holding: fire the **X thread** (copy D). If it's on the front page, quote that. If not, just ship the thread.

**Days 6–10 — Amplify the evergreen:**
- Publish the **dev.to** architecture writeup (copy E) with canonical URL.
- If you have a Lobste.rs account with history, post once (`show` + `authored`).
- Write the retro (see §5): which venue drove installs, which drove *feedback*, kept-vs-discarded ratio so far.

**Rule:** if any single venue surfaces a real bug that would make a new user's first run fail, **stop the sequence and fix it** before the next post. The whole plan is built to get people to a successful first run — don't march past a broken one.

---

## 5. Feedback capture & triage

We instrument for the two signals that actually tell us if glean is worth continuing, and make it frictionless to report.

### 5.1 Channels
- **GitHub Discussions** (primary for open-ended feedback) — enable these categories:
  - `📣 Show & tell` — "here's what glean drafted for me" (these are gold; ask permission to quote).
  - `💡 Ideas` — feature requests.
  - `🙏 Q&A` — setup/usage help.
  - `🧪 Drain reports` — **the important one**: a dedicated category for "I ran a real drain, here's what happened" with a template (below). This is where the pending overnight-run validation comes from the community.
- **GitHub Issues** (for bugs + concrete asks) — with templates:
  - **Bug report** template: OS + version (`glean version`), the command, the `summary.json` reason, relevant lines from `orchestrator.log`, what you expected.
  - **Drain report** template (also usable as an issue): see 5.2.
- **The threads themselves** (Reddit/HN/Discord) — triage live, then convert anything actionable into a GitHub issue so it's not lost when the thread dies.

### 5.2 Feedback template (paste into `.github/ISSUE_TEMPLATE/drain-report.md` and the Discussions category)

```markdown
## Drain / run report

**Environment**
- glean version (`glean version`):
- OS / Windows build:
- Pro / Max / Free:
- Single `glean run` or scheduled `--drain`?

**What it produced**
- Draft branches created: N  → kept: N, discarded: N
- Dossiers created: N        → kept: N, discarded: N, actioned: N
- Did `tests: pass` on the draft match reality when you reviewed it? (y/n)

**Capacity / drain behavior** (if you ran --drain)
- Did it correctly pause at the 5-hour wall and resume?
- Did it stop at the weekly cap without spilling into the new week?
- Exact rate-limit stderr wording you saw (copy/paste — this helps the classifier!):

**The honest question**
- Was the Monday-morning receipt worth the capacity it spent? (1–5)
- What would have made the #1 draft actually useful?

**Anything that broke**
```

### 5.3 The signals that matter most (and how we already get them)

glean ships its own usefulness telemetry — we use it as the launch's primary success metric, not upvotes:

1. **Kept-vs-discarded dossier ratio.** Recorded via `glean rate <id> kept|discarded|actioned`. If people keep/action ≥ ~30–50% of dossiers, the core thesis ("even 30–50% useful is a real save") holds. If they discard almost everything, the *discovery + prioritizer* is the thing to fix, not the marketing.
2. **Draft-branch keep rate.** Of the `prep/glean-*` branches it drafts, how many does someone actually `merge`/`cherry-pick` vs. `glean gc` away? This is the highest-leverage output (`draft-impl` weight 1.0), so its keep rate is the truest "is this valuable" number.
3. **First-run completion rate (qualitative, from threads/issues).** What % of people who say "installing now" report a successful `glean morning`? Every drop-off is a setup-friction bug. This is the funnel metric the launch is really testing.
4. **First real overnight drain confirmation.** A single credible "I scheduled it Friday, here's my Monday receipt from a multi-window drain" report closes the biggest open validation gap *and* becomes the best possible Show-&-tell asset. Actively solicit it.

Vanity metrics we explicitly do **not** optimize for: stars, upvotes, impressions. They're fine as a reach proxy; they don't tell us if glean works. Track installs (npm download stats) as a coarse funnel top, but the kept/discarded and draft-keep ratios are the verdict.

### 5.4 Triage cadence during launch week
- **Live (launch day):** answer every comment in-thread within the active window; convert bugs → issues immediately.
- **Daily:** label new issues `blocks-first-run` (drop everything), `bug`, `enhancement`, `drain-report`, `platform-macos/linux`. Fix `blocks-first-run` same day.
- **End of week:** tally the four signals above, write a short retro (commit it under `docs/`), and let it set the v0.8.2 priorities. If discovery quality is the complaint, that beats drain-robustness in the queue regardless of the current roadmap.

---

## 6. Quick-reference checklist

```
PRE-FLIGHT
[ ] morning-receipt GIF recorded, <3MB, MP4 variant too
[ ] GIF in README above the fold
[ ] GitHub Discussions on (Show&tell / Ideas / Q&A / Drain reports)
[ ] Issue templates: bug + drain-report
[ ] Pinned "Known limitations / help wanted" issue
[ ] Fresh-machine install of @jonny-boy9000/glean verified

ROLLOUT
[ ] Day 1 Tue  — Claude Discord showcase (copy A), AM ET
[ ] Day 2 Wed  — r/ClaudeAI (copy B, Self-Promotion flair), 8–11am ET
[ ] Day 3–4    — triage, fix blocks-first-run, submit awesome-claude-code issue (copy F)
[ ] Day 5/Tue  — Show HN (copy C) 9am ET + first comment + X thread (copy D)
[ ] Day 6–10   — dev.to writeup (copy E), Lobste.rs if eligible, retro

GUARDRAIL
[ ] If a venue surfaces a first-run-blocking bug → pause sequence, fix, then continue
```

---

## Sources (venue norms / timing, verified 2026-06-02)
- Show HN official guidelines: https://news.ycombinator.com/showhn.html
- Show HN timing data (weekend/Sunday windows): https://www.myriade.ai/blogs/when-is-it-the-best-time-to-post-on-show-hn
- HN posting guide (weekday morning ET/PT convention): https://syften.com/blog/hacker-news-marketing/
- Lobste.rs self-promo norms (<25%, `show`/`authored` tags): https://lobste.rs/about and https://aneeshdurg.me/posts/2025/06/12-lobsters/
- Claude community Discord (100k+ members): https://discord.com/invite/prcdpx7qMm
- awesome-claude-code submission workflow (issue, not PR): https://github.com/hesreallyhim/awesome-claude-code
- dev.to canonical URL guidance: https://dev.to/maddy/how-to-add-canonical-links-on-devto-4j3h
- Reddit self-promotion norms (general): https://www.conbersa.ai/learn/reddit-self-promotion-rules
