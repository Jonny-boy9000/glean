# glean launch — Runbook for Stages 1–3 (GIF deferred)

> Companion to [`LAUNCH-PLAN.md`](./LAUNCH-PLAN.md). This is the do-it-now version of the
> first three stages: **Pre-flight → Discord soft launch → r/ClaudeAI**.
>
> **GIF is deferred.** Until it's recorded, every post uses the existing static receipt
> screenshot at [`docs/assets/glean-morning.png`](../assets/glean-morning.png) (already in
> the README). Wherever the copy says "[screenshot]", attach/inline that PNG. When the GIF
> lands later, swap it in and you can re-share with the animated version.

---

## Stage 1 — Pre-flight (≈30–45 min, do before any post)

### 1.1 GitHub Discussions — ✅ enabled, two small things left
Discussions is on. When GitHub enables it, you already get default categories:
**Announcements, General, 💡 Ideas, 🙏 Q&A, 🙌 Show and tell, 📊 Polls.** So Show & tell /
Ideas / Q&A are covered. Two finishing touches (no API for either — do them in the UI):

1. **Add the one custom category** that matters for our signal:
   - https://github.com/Jonny-boy9000/glean/discussions → **Edit categories** (pencil, top-right) → **New category**
   - Name: `🧪 Drain reports`  · Format: **Open-ended discussion**
   - Description: *"Ran glean on a real repo? Tell us what it drafted and what you kept vs. discarded — even a partial report helps."*
2. **Seed a welcome post in 🙌 Show and tell** so the tab isn't empty when the first
   visitor arrives (empty Discussions reads as "dead project"):
   - **New discussion** → category **Show and tell** → title `Welcome — show us what glean drafted for you`
   - Body:
     ```
     If you've run glean, drop your Monday-morning receipt here — what it drafted, what you kept, what you tossed. Screenshots welcome. This is the place for "here's what it did for me" (use Issues for bugs, and the 🧪 Drain reports category for full run reports).

     New here? Start with the pinned "Known limitations & where I'd love help" issue so the honest state is clear: it's early and Windows-first. — Jonny
     ```
   - After posting, **pin** it (••• menu on the discussion → Pin).
3. The issue-template `config.yml` (already committed) routes open-ended feedback here, so this is wired end-to-end.

### 1.2 Issue templates — already created, just commit + push
These three files are in the repo now:
- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/drain-report.md`
- `.github/ISSUE_TEMPLATE/config.yml`

Commit + push them:
```bash
git checkout -b chore/launch-prep
git add .github docs/launch
git commit -m "chore: launch prep — issue templates, runbook, launch plan"
git push -u origin chore/launch-prep
# open a PR and merge to main, or push straight to main if you prefer
```
Verify at **https://github.com/Jonny-boy9000/glean/issues/new/choose** — you should see "Bug report" and "Drain / run report", plus the Discussions link.

### 1.3 Pin a "Known limitations / help wanted" issue
1. **https://github.com/Jonny-boy9000/glean/issues/new** (blank issue).
2. Title: `Known limitations & where I'd love help (start here)`
3. Body — paste this:

```markdown
glean is early and Windows-first. Posting the honest state up front so nobody's surprised, and so it's clear where a contribution or a test report helps most.

### What works today (dogfooded + tested, 806 tests)
- `glean run` discovery → ranked candidates → research dossiers + pre-fetched docs
- `draft-impl`: drafts code for the top TODO into an isolated `git worktree` on a `prep/glean-*` branch, runs your `test_command`, reports pass/fail
- `glean morning` receipt; `glean rate` usefulness telemetry; `glean gc`
- `glean schedule enable` registers the Windows Scheduled Task

### Honest gaps
- **Windows + Linux (beta) scheduler.** macOS launchd is the top request → #1.
- **The unattended multi-day weekend drain has run live once (2026-06-11) but still has limited mileage.** It's built (exit-and-re-enter across the 5-hour wall, resume cursor, weekly-cap stop) and well-tested, but it has had only limited real-account validation. If you run one, a [drain report](https://github.com/Jonny-boy9000/glean/issues/new?template=drain-report.md) is gold.
- Drain robustness polish (configurable circuit-breaker, mid-weekend re-discovery, anti-spill margin) is the v0.8.2 queue.

### Where help matters most
1. **Run it on a real repo and file a [drain report](https://github.com/Jonny-boy9000/glean/issues/new?template=drain-report.md)** — what you kept vs. discarded is the signal I care about.
2. **macOS launchd port** (#1; Linux is in beta).
3. **The exact rate-limit signal** from a real account during a drain (paste the `rate_limit_event` line from the task `.jsonl`).

Thanks for trying it. — Jonny
```

4. After creating it: **Pin issue** (right sidebar on the issue page) so it sits at the top of the issues list.

### 1.4 Verify a clean install
On a machine (or fresh shell) without the dev checkout on PATH:
```bash
npm i -g @jonny-boy9000/glean
glean version
glean run --project C:\some-real-repo --dry-run
```
Confirm the dry run prints a ranked candidate list with no crash. If it crashes, fix before posting — a broken first run sinks the whole sequence.

### 1.5 Confirm the screenshot renders
Open the repo README on github.com and confirm `docs/assets/glean-morning.png` shows above the fold. That's your launch image until the GIF exists.

**Stage 1 exit check:** Discussions on · templates live at `/issues/new/choose` · known-limitations issue pinned · `npm i -g` works on a clean shell · README screenshot renders.

---

## Stage 2 — Claude Discord `#Built-With-Claude` board (Day 1, Tue, late morning ET)

Lowest-stakes venue. Goal: first round of "wait, does it…" questions to sharpen the Reddit post.

> **This board has explicit rules — the copy below is written to satisfy each one.** Don't strip these elements:
> - built with Claude/Claude Code → the post says so explicitly (and it's true — glean was)
> - clear description of *what you built, how Claude helped, what it does* → all three present
> - free to try → stated (MIT, npm, free)
> - **minimal promotional language, context not just links** → tone is plain; no hype words
> - **downloadable executable → security disclaimer + transparent about what data/credentials it accesses** → the "Security & data" paragraph is mandatory here
> - no affiliate/referral links · no job-seeking · careful with personal info → none present

### Steps
1. **Join:** https://discord.com/invite/prcdpx7qMm (the Claude community server). If that invite is stale, get the current link from claude.ai / Anthropic.
2. Go to the **`#Built-With-Claude`** community board. Re-read its pinned requirements once more before posting.
3. **Post the message below.** Attach `docs/assets/glean-morning.png` directly (drag-drop) so the receipt shows inline — this is "context, not just a link," which is exactly what the board asks for.
4. **Stay present** for a couple of hours. Answer everything. DM anyone who says "I'll try it" and offer to walk them through setup.
5. **Capture every point of confusion** — each one is a README/FAQ edit before Stage 3.

### Text to post (rules-compliant; GIF deferred → screenshot attached)
```
glean — spends your leftover weekly Claude capacity on prep work while you're away

What it is: a local CLI for the problem we all have on Pro/Max — the weekly rate-limit window resets Saturday and whatever capacity you didn't spend just evaporates. In that idle tail, glean spawns headless `claude -p` sessions to do speculative prep on your own repos: it drafts code for your top TODO into a throwaway git worktree branch (never touches main), writes research dossiers for unfinished threads it finds in your session history + `git grep TODO/FIXME`, and pre-fetches library docs. Point Windows Task Scheduler at it and it drains the weekend's leftover unattended. Monday you run `glean morning` and get a receipt — each draft branch with a verified `tests: pass` and the command to review it. (Real receipt screenshot below.)

How Claude helped: glean was built almost entirely with Claude Code — the discovery heuristics, the executor that wraps `claude -p`, the Windows Task Scheduler integration, and its 806 tests. And at runtime it *is* Claude Code: every unit of work is a headless `claude -p` session it spawns and supervises.

Security & data (it's a downloadable CLI, so here's exactly what it touches): glean runs entirely on your machine. It reads — read-only — your local git repos and your `~/.claude/projects` session history to find unfinished work, and it drives your own already-logged-in `claude` CLI. It never reads, stores, or transmits your credentials, makes no direct API calls, and sends nothing off your machine; all output is written locally under `~/glean`. Every spawned session runs under a deny-list that blocks `git push` / `checkout` / `reset` and `gh pr` mutations, so it can't touch your main branch or publish anything. MIT-licensed and fully inspectable.

Free: yes, MIT, `npm i -g @jonny-boy9000/glean`. Honest status: early and Windows-first. It runs for real now — my latest live run against `claude -p` produced research dossiers + pre-fetched docs with zero failures, and the unattended weekend drain is armed and ticking. The one thing I haven't watched in the wild yet is it hitting the hard weekly cap on a full multi-day drain, so I'd value people running it on their own repos and telling me what breaks.

https://github.com/Jonny-boy9000/glean

If it could pre-draft ONE thing on your repo before Monday, what would you want it to be — the top TODO, a failing test, a PR reply?
```

**Stage 2 exit check:** posted in `#Built-With-Claude` with the security paragraph + "how Claude helped" intact · screenshot attached · present + replied ~2h · confusion points → README/FAQ tweaks queued.

---

## Stage 3 — r/ClaudeAI "Built with Claude" Showcase Megathread (Day 2, Wed, 8–11am ET / 5–8am PT)

The sanctioned route on r/ClaudeAI is a **comment in the Showcase Megathread**, not a
standalone post — respect that first. (A standalone Self-Promotion post is a *possible*
follow-up later if the comment gets real traction and people ask for more, but lead with
the megathread; it's where the mods and the right audience expect project shares.)

**Megathread:** https://www.reddit.com/r/ClaudeAI/comments/1sly3jm/built_with_claude_project_showcase_megathread/

### Steps
1. **Apply the Stage 2 fixes** to the README/FAQ and to the comment text below.
2. Open the megathread (link above). **Skim the top-level post + a few existing comments** for any stated format the mods want (I couldn't auto-fetch it — Reddit blocks automated reads — so eyeball it yourself).
3. **Post the comment below as a top-level reply** to the megathread. Reddit comments render the screenshot only as a link, so add the image link inline (use the GitHub raw URL of the receipt, already in the README): `https://raw.githubusercontent.com/Jonny-boy9000/glean/main/docs/assets/glean-morning.png`
4. **No title, no flair** — it's a comment, not a post.
5. **Be present 3–4 hours.** Reply to every response. Convert any bug into a GitHub issue immediately and link it back ("filed as #N, thanks").
6. **Loop your testers:** anyone who says "installing" — follow up next day asking for a [drain report](https://github.com/Jonny-boy9000/glean/issues/new?template=drain-report.md).

### Comment text (megathread; "Built with Claude" framing, GIF deferred → screenshot linked)
```
**glean** — it spends your leftover weekly Claude capacity on prep work while you're away.

Built with: Claude Code, top to bottom — discovery heuristics, the executor that wraps `claude -p`, the Windows Task Scheduler integration, 806 tests. And at runtime it *is* Claude Code: every unit of work is a headless `claude -p` session it spawns and supervises.

What it does: on Pro/Max your weekly rate-limit window resets Saturday and the capacity you didn't spend just evaporates. In that idle tail, glean does speculative prep on your own repos — drafts code for your top TODO into a throwaway `git worktree` branch (never touches main), writes research dossiers for unfinished threads it finds in your `~/.claude` session history + `git grep TODO/FIXME`, and pre-fetches docs. Point Windows Task Scheduler at it and it drains the weekend's leftover unattended, pausing at each 5-hour limit and stopping the moment the weekly cap fires so it never spills into next week. Monday: `glean morning` prints a receipt — each draft branch with a verified `tests: pass` and the command to review it.

Real receipt: https://raw.githubusercontent.com/Jonny-boy9000/glean/main/docs/assets/glean-morning.png

Safe by design: it drives your own logged-in `claude` CLI (no API key, no proxying, nothing leaves your machine), reads your repos + session history read-only, and every spawned session runs under a deny-list blocking `git push`/`checkout`/`reset`/`gh pr` so it can't touch main or publish anything. MIT, free: `npm i -g @jonny-boy9000/glean`.

Honest status: early; Windows + Linux (beta) scheduler (macOS launchd is the top tracked issue, #1). Single-run + draft path is dogfooded; the unattended multi-day drain has run live (first real run 2026-06-11) but still has limited mileage — so I'd love for someone to try it and tell me what breaks.

Repo: https://github.com/Jonny-boy9000/glean — what would you want it to draft first on your own projects?
```

**Stage 3 exit check:** posted as a megathread comment (no standalone post) · receipt image linked via raw URL · present + replied 3–4h · bugs → issues + linked in-thread · testers followed up with the drain-report link.

---

## What comes after (not in this runbook)
Stage 4 = listen/harden + submit to awesome-claude-code; Stage 5 = Show HN + X; Stage 6 = dev.to. See [`LAUNCH-PLAN.md`](./LAUNCH-PLAN.md) §4. **Record the GIF before Stage 5 (Show HN)** — it matters most there.
