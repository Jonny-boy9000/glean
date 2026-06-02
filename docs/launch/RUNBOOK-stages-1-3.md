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

### 1.1 Turn on GitHub Discussions
1. Go to **https://github.com/Jonny-boy9000/glean/settings**
2. Scroll to **Features** → check **Discussions**.
3. Open **https://github.com/Jonny-boy9000/glean/discussions** → **Categories** (pencil/edit) and make sure these exist:
   - `📣 Show & tell` (Announcement or Open-ended)
   - `💡 Ideas`
   - `🙏 Q&A` (Question/Answer format)
   - `🧪 Drain reports` (Open-ended) ← the important one
4. Done. The issue-template `config.yml` (already committed) points people here.

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

### What works today (dogfooded + tested, 352 tests)
- `glean run` discovery → ranked candidates → research dossiers + pre-fetched docs
- `draft-impl`: drafts code for the top TODO into an isolated `git worktree` on a `prep/glean-*` branch, runs your `test_command`, reports pass/fail
- `glean morning` receipt; `glean rate` usefulness telemetry; `glean gc`
- `glean schedule enable` registers the Windows Scheduled Task

### Honest gaps
- **Windows-only scheduler.** macOS/Linux is the top request → #1.
- **The unattended multi-day weekend drain hasn't had a real overnight validation run in the wild yet.** It's built (exit-and-re-enter across the 5-hour wall, resume cursor, weekly-cap stop) and unit-tested, but I haven't watched a full weekend drain happen on a live account. If you run one, a [drain report](https://github.com/Jonny-boy9000/glean/issues/new?template=drain-report.md) is gold.
- Drain robustness polish (configurable circuit-breaker, mid-weekend re-discovery, anti-spill margin) is the v0.8.2 queue.

### Where help matters most
1. **Run it on a real repo and file a [drain report](https://github.com/Jonny-boy9000/glean/issues/new?template=drain-report.md)** — what you kept vs. discarded is the signal I care about.
2. **macOS/Linux port** (#1).
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

## Stage 2 — Claude Discord soft launch (Day 1, Tue, late morning ET)

Lowest-stakes venue. Goal: first round of "wait, does it…" questions to sharpen the Reddit post.

### Steps
1. **Join:** https://discord.com/invite/prcdpx7qMm (the Claude community server, 100k+ members). If that invite is stale, search "Claude Discord" from claude.ai / Anthropic's site for the current link.
2. **Find the right channel.** Look for a project-showcase / "what are you building" / "i-made-this" channel. **Do not post in general chat.** If unsure, ask in a meta/help channel which channel is right for sharing a tool.
3. **Read the channel pins/rules** before posting (some servers require a specific format or limit self-promo to a thread).
4. **Post the message below.** Attach `docs/assets/glean-morning.png` directly to the message (drag-drop) so the receipt shows inline.
5. **Stay present** for a couple of hours. Answer everything. DM anyone who says "I'll try it" and offer to walk them through `glean schedule enable`.
6. **Capture every point of confusion** — each one is a README/FAQ edit before Stage 3.

### Text to post (GIF deferred → screenshot attached)
```
Built a thing for the weekly-limit problem we all have 👇

Your Pro/Max weekly window resets Saturday and whatever capacity you didn't spend just evaporates. `glean` is a CLI that spends that idle tail for you: it scans your repos + Claude session history for unfinished work and spawns headless `claude -p` sessions to draft code into throwaway git worktree branches (never touches main), write research dossiers, and pre-fetch docs. Point Windows Task Scheduler at it and it drains the weekend's leftover unattended. Monday you run `glean morning` and get a receipt — each draft branch with a verified `tests: pass` and the command to review it.

(screenshot of a real `glean morning` receipt attached 👇)

Honest status: it's early and Windows-first right now. Single-run + draft-branch path is dogfooded and tested; the unattended multi-day drain is built but hasn't had its first real overnight run in the wild — so I'm partly here to find people who'll try it and tell me what breaks.

Repo: https://github.com/Jonny-boy9000/glean  (npm: @jonny-boy9000/glean)

Question for the room: if it could pre-draft ONE thing on your repo before Monday, what would you want it to be — the top TODO, a failing test, a PR reply?
```

**Stage 2 exit check:** posted in showcase · present + replied for ~2h · confusion points written down · README/FAQ tweaks queued.

---

## Stage 3 — r/ClaudeAI (Day 2, Wed, 8–11am ET / 5–8am PT)

Apply the Discord learnings first, then post to the densest concentration of the exact audience.

### Steps
1. **Apply Stage 2 fixes** to the README/FAQ and to the body text below.
2. Go to **https://www.reddit.com/r/ClaudeAI/**.
3. **Read the rules** (right sidebar → "Rules" / "About"). Confirm two things:
   - Whether there's a **weekly self-promotion megathread** this week. If yes, post there first (or in addition).
   - That a standalone tool post is allowed with the right flair.
4. **Create the post** → it's a **text/self post** with an image. Paste the title + body below. Attach `docs/assets/glean-morning.png` as the image.
5. **Set the flair to `Self-Promotion`** (required). The post will likely be auto-removed without it.
6. **Be present 3–4 hours.** Reply to every comment. Convert any bug into a GitHub issue immediately and link it back in the thread ("filed as #N, thanks").
7. **Loop your testers:** anyone who says "installing" — follow up next day asking for a drain report (link the template).

### Title
```
I built a CLI that drains my leftover weekly Claude capacity into Monday-morning draft branches (early, Windows-first)
```

### Body (GIF deferred → image attached to the post)
```
Like most of you, my Pro/Max weekly window resets Saturday and by Thursday I've spent the high-value work — leaving capacity that doesn't roll over. That bugged me enough to build `glean`.

In that idle tail it spawns its own headless `claude -p` sessions to do speculative prep on my own repos:
- drafts code for my top TODO into an isolated `git worktree` on a `prep/glean-*` branch (main is never checked out, pushed, or merged)
- writes research dossiers for unfinished threads it finds in my session history + `git grep TODO/FIXME`
- pre-fetches library docs as cheap filler

Point Windows Task Scheduler at it (`glean schedule enable`) and it drains the whole weekend's leftover unattended — it pauses at each 5-hour limit, resumes when the window reopens, and stops the moment the weekly cap fires so it never spills into the new week. Monday I run `glean morning` and get a receipt of everything it did, each draft branch with a verified `tests: pass`. (Screenshot of a real receipt below.)

On "is this allowed": it drives my own logged-in `claude` CLI — the same `claude -p` calls I could type by hand. No API key, no proxying. Every spawned session runs under a deny-list blocking `git push`/`checkout`/`reset`/`gh pr` mutations.

Honest caveats: it's early and Windows-first (macOS/Linux is the top tracked issue). The single-run + draft path is dogfooded and tested (352 tests). The unattended multi-day drain is built but hasn't had its first real overnight validation run yet — so genuinely looking for people to try it and report back.

Repo + install: https://github.com/Jonny-boy9000/glean  (`npm i -g @jonny-boy9000/glean`)

What would you want it to draft first on your own projects? And does anyone else actually feel the Friday-capacity waste, or is it just me?
```

**Stage 3 exit check:** Self-Promotion flair set · image attached · present + replied 3–4h · bugs → issues + linked in-thread · testers followed up with the drain-report link.

---

## What comes after (not in this runbook)
Stage 4 = listen/harden + submit to awesome-claude-code; Stage 5 = Show HN + X; Stage 6 = dev.to. See [`LAUNCH-PLAN.md`](./LAUNCH-PLAN.md) §4. **Record the GIF before Stage 5 (Show HN)** — it matters most there.
