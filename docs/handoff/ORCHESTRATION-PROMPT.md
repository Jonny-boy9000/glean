# Orchestration prompt — gstack pipeline + Superpowers subagents

A reusable kickoff prompt that reproduces the build pattern used for v0.8.2/v0.8.3: the **gstack
pipeline** (office-hours → plan-eng-review → ship) as the main loop, spawning **worktree-isolated
subagents that each follow Superpowers TDD**. Fill in `<TASK>` and paste it as the **first message**
of a fresh session.

## How to use

1. Pick `<TASK>` from [`../ROADMAP.md`](../ROADMAP.md) "Up next" / backlog (suggestions below).
2. Paste the prompt block into a new session.
3. The session drives the whole pipeline; it stops for your approval at the design gate and before
   any merge/npm-publish.

**Do NOT use this prompt for:**
- **Closing ADR-0001 (the real-block capture)** — that's blocked until the scheduled drain actually
  hits the weekly cap and `~/glean/logs/<run>/<task>.BLOCK-CAPTURE.txt` appears. See the live
  [`post-v0.9.0-handoff.md`](./post-v0.9.0-handoff.md) (item 3) for the current framing; the dedicated
  kickoff prompt is in the archived [`post-v0.8.2-handoff.md`](../archive/post-v0.8.2-handoff.md).
- **Launch / demo-GIF** — needs you (recording, posting), not a subagent build. See the launch
  prompt in the archived [`post-v0.8.2-handoff.md`](../archive/post-v0.8.2-handoff.md).

## Good `<TASK>` choices (from the roadmap)

- `the fetch-docs deny-list fix — grant fetch-docs a narrow doc-fetch allow-list (context7 + WebFetch to known doc hosts) so it stops degrading to model-knowledge docs` ← most build-ready; surfaced in the v0.8.2 live run
- `API-key fallback when Pro/Max rate-limits (ROADMAP Up-next #2, ~75 LOC)`
- `the top item from docs/ROADMAP.md "Up next" (confirm with me first)`

## The prompt (paste this)

```
Build <TASK> for glean end to end, and you orchestrate it with the gstack + superpowers pipeline.

Read first, in order: CLAUDE.md, docs/handoff/post-v0.9.0-handoff.md, docs/ROADMAP.md,
docs/PROJECT-MAP.md, and any ADR in docs/decisions/ that touches the area you'll change. v0.9.0 is
prepped on branch `chore/full-review-improvements` (npm still publicly at v0.8.5). If <TASK> is "pick
the top item", confirm the choice with me from docs/ROADMAP.md "Up next" before designing anything.

Run the full pipeline, you as the orchestrator:

1. /office-hours — lock the design. It finds prior design docs in
   ~/.gstack/projects/Jonny-boy9000-glean/ and docs/design/. Since this is a well-specified
   bucket, skip the Phase-2 interrogation; do the premise challenge + forced alternatives, run
   ONE adversarial fresh-context spec review, fix what it finds, and mirror the final design doc
   into docs/design/. Bring it to me for approval before any code.

2. /plan-eng-review — lock architecture + a per-lane test plan. Decide lane boundaries by
   DISJOINT file sets so the lanes merge clean. Surface only genuinely-new decisions to me.

3. Implement with the superpowers subagent-driven-development skill. Spawn ONE
   worktree-isolated subagent per independent lane, in parallel (multiple Agent calls in one
   message), each told to follow superpowers test-driven-development (write the failing test
   FIRST). Give each subagent: a complete self-contained spec, ONLY its lane's file set, the env
   setup (junction node_modules to C:\Glean\node_modules via `New-Item -ItemType Junction`;
   NEVER npm-install while junctioned), and the report format (status, branch, HEAD SHA, changed
   files, full `npm test` summary). You manage them. Then run a per-lane spec + code-quality
   review (parallel reviewers, one per lane), apply the fixes yourself, add a cross-lane
   integration test, merge the lane branches into your feature branch, and run a final
   whole-implementation review.

4. /ship — bump the version, write the CHANGELOG, sync ROADMAP/CLAUDE.md/PROJECT-MAP/handoff,
   push, and open a PR. Do NOT merge or npm-publish without my explicit go-ahead.

Honor every load-bearing constraint in CLAUDE.md: subscription-auth only (no API key in the core
path), read-only against main, deny-list on every `claude -p` spawn, max_parallel=1,
Windows-first, atomic state/budget.json, and the bare `glean run` path stays byte-identical (all
changes additive + gated on drain state). Honor the ADR discipline: a finding that overturns a
prior decision is a hypothesis to disprove — verify the negative case before asserting; mark
verified-vs-assumed at the code site and add/supersede an ADR for any load-bearing or unverified
decision. Keep the docs current as you go (update PROJECT-MAP on any layout change). Nothing
merges or publishes without my explicit word.
```

## Why each piece is there (so you can adapt it)

- **Read-first list** → the session inherits the project's state + constraints + design history
  without you re-explaining (the three trees are in PROJECT-MAP).
- **"skip Phase-2 interrogation"** → office-hours otherwise asks the six founder questions; for a
  well-specified roadmap item that's noise. The adversarial spec review is the part that earns its
  keep (it caught 4 real mechanism-mismatches on v0.8.2).
- **Disjoint file sets per lane** → this is what makes the parallel worktree subagents merge without
  conflicts. If two lanes must touch the same file, put them in ONE sequential lane.
- **`node_modules` junction** → a fresh git worktree has no deps; the junction shares the main
  checkout's built deps (incl. the native better-sqlite3) so the subagent can build + run the full
  suite. `npm install` while junctioned would write back into the main repo — hence "never".
- **Per-lane review + final whole-impl review** → per-lane catches lane-local bugs; the final pass
  catches cross-lane interactions the isolated reviews can't see (it's how the byte-identical
  invariant got verified holistically).
- **"Nothing merges/publishes without my word"** → every outward action stays gated; the session
  opens a PR and stops.
