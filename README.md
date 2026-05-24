# glean

> **Glean turns your unused Friday Claude capacity into a Monday-morning head-start.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757)](https://claude.com/claude-code)

> **🍎 macOS / Linux:** glean is Windows-first today. Cross-platform support is the [top tracked issue](https://github.com/Jonny-boy9000/glean/issues/1) — PRs very welcome.

You're on a Claude Pro or Max subscription. The weekly rate-limit window resets Saturday morning. By Thursday and Friday you've often spent the high-value work and have unused capacity that **doesn't roll over**.

`glean` is a local CLI that, during that idle tail-window, spawns its own headless `claude -p` sessions to do *speculative* prep work on your existing projects — drafting research dossiers, pre-fetching library docs, surfacing the TODOs and PRs you keep meaning to come back to. Next week, you open a "prep folder" and find a head-start.

> *gleaning* (n.) — the practice of gathering leftover crops from the field after the main harvest. `glean` does the same with unused capacity at the tail of your weekly rate-limit window.

<!-- TODO: drop in screenshot of a rendered INDEX.md here (the Monday-morning payoff) -->
<!-- TODO: drop in a ~20s terminal GIF of `glean run --dry-run` showing the ranked candidate list -->

---

## Is this allowed?

**Yes.** `glean` drives *your own* logged-in Claude Code CLI — the same headless `claude -p` invocations you could type by hand. No API key, no proxying, no shared accounts. You're using *your* subscription, just on a schedule.

(The earlier, rejected design for this project *was* an MCP that resold leftover tokens. That idea is documented as explicitly dropped in [`glean.md`](./glean.md) §2 because it would have violated Anthropic's Usage Policies and Commercial Terms.)

---

## Quick start

```bash
git clone https://github.com/Jonny-boy9000/glean.git
cd glean
npm install
npm run build
npm install -g .

# Dry-run first — discovers and ranks candidates without spawning Claude
glean run --project C:\some-repo --dry-run

# Then the real thing — 60-minute default budget
glean run --project C:\some-repo
```

First run auto-creates `%USERPROFILE%\glean\config.json` with sensible defaults. See [Advanced configuration](#advanced-configuration) if you need to override `claude_bin` or anything else.

**Requirements:** Node 20+, the `claude` CLI on PATH (logged into a Pro/Max subscription), Git. Optional: `gh` for PR-based discovery.

---

## How it works

Three discovery sources run in parallel:

1. **Claude Code session history** — scans `~/.claude/projects/<project>/*.jsonl` for sessions whose AI-generated title mentions TODO/FIXME/etc.
2. **`git grep` for `TODO`/`FIXME`/`XXX`/`HACK`** plus `gh pr list` (if available) for unresolved review comments.
3. **Recently-added dependencies** in `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml` (last 14 days via `git log`).

Each candidate becomes a single `claude -p` invocation, sandboxed inside a Windows Job Object so the child tree dies cleanly on Ctrl-C or `glean stop`. The spawned Claude session runs with `--disallowedTools` blocking `git push`, `git checkout main`, and `gh pr` mutations — speculative work only, no production-affecting changes.

For the full architecture see the design spec under [`docs/superpowers/specs/`](./docs/superpowers/specs/).

---

## What you get back

After a run completes, open `INDEX.md` for the day. It looks like this:

```markdown
---
run_id: 2026-05-24-1221-a69612
project_path: C:\Glean
generated_at: 2026-05-24T12:38:11-04:00
entries:
  - task_id: 8e7c…
    type: research-dossier
    title: "Handle TODO in src/lib/executor.ts"
    output: research-handle-todo-in-src-lib-executor-ts/OUT.md
    status: ok
---

# Glean dossier — 2026-05-24

1. **Handle TODO in src/lib/executor.ts** — ok
   - Read: `research-handle-todo-in-src-lib-executor-ts/OUT.md`

2. **Pre-fetch docs for zod** — ok
   - Read: `docs/zod.md`
```

Each linked `OUT.md` is a structured note Claude wrote during the idle window — summary, findings, suggested next actions, open questions. Average size in real dogfood runs is ~5KB of focused, actionable prose. ([Real example output here.](./docs/open-work/03-dogfood-results.md))

### Output tree

```
%USERPROFILE%\glean\
  dossiers\<project>\<YYYY-MM-DD>\
    INDEX.md                          ← start here on Monday morning
    research-<slug>\OUT.md            ← one per research dossier
    docs\<library>.md                 ← one per fetch-docs task
  state\<run-id>\
    candidates.json                   ← ranked candidate list (for debugging)
    summary.json                      ← run outcome and counts
  logs\<run-id>\
    orchestrator.log                  ← ndjson event log
    <task-id>.jsonl                   ← raw claude -p stream
    <task-id>.stderr                  ← raw stderr
```

---

## FAQ

**Will it burn my whole weekly limit?**
No. Default budget is 60 minutes (`--budget 60m`). Override with `--budget 30m`, `--budget 2h`, etc. `glean` checks the budget between every task and exits cleanly once exhausted. It also stops immediately on any rate-limit signal in `claude -p` stderr — no retries, no back-off ladder, no hidden second-attempts.

**Does it touch my main branch?**
No. The MVP only produces *research dossiers* and *fetched docs* under `%USERPROFILE%\glean\` — your repos are read-only. Every spawned `claude -p` is launched with `--disallowedTools` blocking `git push`, `git checkout main`, `gh pr merge`, and `gh pr create`. A future `draft-impl` mode will write code into isolated git worktrees on disposable `prep/*` branches; still won't touch main.

**What if I'm not on Pro/Max?**
You'll need *some* logged-in `claude` CLI. The free tier's stricter rate limits will cause glean to exit early via the rate-limit signal — it'll still work, just produce less per run.

**How much does a typical run consume?**
The dogfood run against this repo (1178 LOC, 25 candidates discovered, 14 ran) used about 28 minutes of wall-clock and produced 14 OUT.md files. Your mileage varies with project size and budget.

**What if I cancel mid-run?**
Either Ctrl-C the orchestrator or run `glean stop` from another shell. Both kill the child `claude -p` tree (via a Windows Job Object) and exit cleanly. `glean stop` is checked *between* tasks, so the in-flight task finishes naturally before the run exits with code 30.

**Can I run it on a schedule?**
Not in the current release. Windows Task Scheduler / launchd / cron integration is on the [roadmap](#coming-next).

---

## Scripting

`glean` exits with structured codes so you can wire it into shell scripts:

| Code | Meaning |
|---|---|
| 0 | Completed normally (or no candidates found) |
| 10 | Wall-clock budget exhausted |
| 20 | Claude rate-limit detected — stopped cleanly |
| 30 | STOP sentinel triggered (`glean stop`) |
| 40 | Another `glean run` is holding the lock |
| 1 | Unexpected error |

The orchestrator also writes a structured ndjson event log at `%USERPROFILE%\glean\logs\<run-id>\orchestrator.log` and a final `summary.json` capturing reason + counts.

---

## Advanced configuration

`%USERPROFILE%\glean\config.json` is auto-created on first run. The only currently-meaningful field:

```json
{
  "claude_bin": "claude"
}
```

Point this at a specific `claude` executable if `claude` isn't on PATH or you want to use a different installation. A `projects.<absolute-path>.base_branch` field is also accepted by the schema for forward-compatibility with the upcoming `draft-impl` worktree mode — currently a no-op.

To discard a day's output:

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\glean\dossiers\<project>\<YYYY-MM-DD>"
```

---

## Coming next

- **Code drafts in git worktrees** (`draft-impl` candidate type) — Claude writes speculative implementations on disposable `prep/*` branches you can cherry-pick or discard.
- **Scheduling** — Windows Task Scheduler / launchd / cron integration so glean runs automatically Thursday evening.
- **macOS / Linux** — see [issue #1](https://github.com/Jonny-boy9000/glean/issues/1).

Plus smaller items on the [issue tracker](https://github.com/Jonny-boy9000/glean/issues). The full vision is documented in [`glean.md`](./glean.md).

---

## Contributing

Issues, ideas, and PRs welcome.

Start with [`glean.md`](./glean.md) (the vision doc) and the design spec under [`docs/superpowers/specs/`](./docs/superpowers/specs/) to understand what's intentionally out of scope versus genuinely missing. The implementation plan under [`docs/superpowers/plans/`](./docs/superpowers/plans/) shows how the existing code was structured task-by-task — new features should follow the same modular pattern (one file per responsibility, TDD-style tests, ~600–1200 LOC sub-projects).

To run tests locally:

```bash
npm test          # full suite, ~2 min
npm run lint
npm run build
```

The test stub at `test/fixtures/fake-claude.cmd` simulates `claude -p` so integration tests don't burn real subscription capacity.

---

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md) for what's new in each release.

---

## License

[MIT](./LICENSE) — © 2026 [Jonny-boy9000](https://github.com/Jonny-boy9000)

---

⭐ **Star to follow the roadmap from MVP → v1.** Questions, war stories, or ideas? Open a [discussion](https://github.com/Jonny-boy9000/glean/discussions) or an [issue](https://github.com/Jonny-boy9000/glean/issues).
