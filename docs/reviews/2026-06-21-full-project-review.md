# Glean — Full Project Review & Improvement Plan (2026-06-21)

> Produced by a 7-dimension multi-agent review (safety enforcement, engine correctness,
> security/injection, test quality, docs/adoption, architecture/deps, repo hygiene/packaging).
> **Every `critical`/`high` finding was independently adversarially verified** before inclusion,
> per CLAUDE.md's "a finding that overturns a decision is a hypothesis to disprove" discipline.
>
> **Ground truth this session:** build ✅ · eslint ✅ (exit 0) · `vitest run` = **697 passed / 7 skipped /
> 64 files** (exit 0). Repo at **v0.8.5 + v0.9 wave-1 merged** to `main` (usage/pacing, model-routing,
> project-portfolio, discover-docs, serve-autostart).

## 1. Verdict

**Glean is worthy of use today.** The thing that matters most for a tool that spawns autonomous
`claude -p` sessions against real repos — its safety posture — is genuinely, mechanically enforced:

- **No Anthropic API-key path exists** anywhere in `src/` (constraint #1 holds).
- **Every** spawn funnels through one `runClaude()` that unconditionally appends the deny-list
  (`executor.ts:809`); there is no second spawn site and no path that omits it.
- `draft-impl` pairs a deny-list **with** a scoped allow-list (bare `Bash` provably never granted)
  **with** `--add-dir` worktree confinement; `research-dossier` uses a read-only allow-list.
- `max_parallel` is hardcoded to 1 (no `--parallel` flag); STOP + budget checked before every task.
- The localhost dashboard is well-defended: `127.0.0.1`-only bind + custom-header anti-CSRF +
  loopback-Host anti-DNS-rebinding + Origin check + path-traversal guard (verified against `..\` on
  Windows) + scheme-whitelisted markdown rendering (verified `javascript:` neutralized).

**There are no Critical findings and no surviving High findings.** Both items reported at "high" were
resolved on the second pass: the deny-list-test-gap was severity-adjusted to medium (production code is
correct; only the *regression test* is missing), and the "README lies about config auto-create" claim
was **refuted as a false positive** (`cli.ts:45` calls `ensureDefaultConfig` one line above the code the
reviewer quoted).

**The single biggest risk is documentation/release drift, not a safety hole.** The cold-start handoff
says v0.8.3/406-tests and points at an already-closed task; three index docs cite three different wrong
test counts (406/538/538 vs ~697); the entire shipped v0.9 surface (`glean usage`, `glean projects`,
discover-docs, model routing) is invisible in the README and parked under CHANGELOG "Unreleased" with no
tag. The only confirmed correctness bug is the `gc` prep-branch leak — ref-store clutter, not data loss.

## 2. Confirmed findings (post-verification)

| # | Sev | Finding | Location | Fix | Effort |
|---|-----|---------|----------|-----|--------|
| F1 | med | **gc prep-branch leak.** `prepBranchFor` uses `lastIndexOf('-')`, so for a real hyphenated UUID id it reconstructs `prep/glean-<last-segment>` and `git branch -D` silently misses the real `prep/glean-<full-uuid>` → branch leaks forever. The gc test masks it (`stale-aaaa`, no internal hyphen). | `gc.ts:13-16`, `gc.test.ts:34` | Derive branch authoritatively from `git -C <main> worktree list --porcelain`; add a real-UUID gc test. | small |
| F2 | med | **Deny-list-on-every-spawn never asserted at argv level.** Only the deny *constant* is unit-tested; the argv-capture harness asserts `--allowedTools` but never `--disallowedTools`. A refactor dropping `executor.ts:809` or swapping the string passes all 697 tests. Production code is correct today — this is a missing regression guard on the #1 safety boundary. | `executor.ts:809` vs `v23-dossier-read-access.test.ts:86-90` | Assert `argv[indexOf('--disallowedTools')+1] === BASE_DENY` (research) + `=== DRAFT_IMPL_DENY` (draft-impl). Harness already captures argv. | trivial |
| F3 | med | **PowerShell injection in scheduled-task registration.** `day` interpolated raw/unquoted (`-DaysOfWeek ${day}`); path escaping is `"`-only and doesn't neutralize `$(...)`. Values come from CLI flags/`config.json` (not the web surface), so it's defense-in-depth, not remote RCE. | `schedule.ts:106-109`, `serve-install.ts:74-76` | Whitelist `day` ∈ weekday names + `time` against `^\d{2}:\d{2}$`; emit a temp `.ps1` with `-File`/single-quoted-literal marshalling. | small |
| F4 | med | **Dashboard DNS-rebinding/loopback-Host guard untested.** Only the CSRF-header rejection is covered; `isLoopbackHost` + Origin check have no test (`fetch()` can't forge a non-loopback Host). | `serve.ts:70-81` | Direct `createHandler` tests: forged `host:'evil.com'` → 403, cross-origin Origin → 403, + `isLoopbackHost` unit table. | small |
| F5 | med | **Cross-day INDEX dedup ignores status.** The in-burst ledger honestly excludes failed/timeout tasks (ADR-0003), but `extractHashesFromIndex` applies no status filter, so a previously-FAILED candidate is suppressed for 7 days — genuinely-unfinished work skipped for a week. No test covers a `status: error` INDEX entry. | `dedup.ts:94-104` | Filter on `OK_STATUSES` to match the in-burst ledger; pin with a `status: failed` test. | small |
| F6 | med | **`better-sqlite3` native dep loads eagerly at CLI startup.** A missing prebuilt fails `npm i -g` outright; and because the import is static on `cli.ts`'s path, a failed binding kills **every** command incl. `glean version`. Runtime already degrades gracefully (Memory→null), so the risk is concentrated at install/load. | `cli.ts:5,7,14` → `memory.ts:1`; `package.json:48` | Lazy-load Memory (`await import`) + try/catch no-op; document build-tools prereq. Optionally migrate to built-in `node:sqlite`. | medium |
| F7 | med | **`executor.ts` god-file (789 LOC, 6+ responsibilities).** Spawn state machine + draft-git plumbing + test-runner + classification glue interleaved with ADR-0003/0004 invariants. | `executor.ts:1-1072` | Extract `spawn-claude.ts`, `draft-git.ts`, `draft-test.ts` behind existing `fn.impl` seams. No behavior change. | large |
| F8 | med | **`RATE_LIMIT_RE` duplicated verbatim** in two files, both with "keep in sync" comments. Drift would silently change drain-exit behavior. | `executor.ts:23` + `classify.ts:40` | Export from `classify.ts`, import in executor. | trivial |
| D1 | med | README "How it works" still says the rate-limit horizon is classified **"from stderr"** — superseded by ADR-0003 (structured stream-json, empty stderr), Accepted + shipped. | `README.md:105` | Describe the structured `rate_limit_event` signal as primary, stderr as fallback; drop the "capture the stderr wording" Coming-next clause. | trivial |
| D2 | med | README missing the entire shipped v0.9 surface (`usage`, `projects`, discover-docs as a 4th pass, model routing). "Coming next" lists v0.8.2-**shipped** items (circuit-breaker, anti-spill, mid-weekend re-discovery). | `README.md:70-99,263` | Add `usage`/`projects`/`doctor` rows + 4th discovery pass + capacity-governor blurb; prune shipped Coming-next. | small |
| D3 | med | CHANGELOG keeps merged v0.9 wave-1 under "Unreleased" with no tag; `usage`/pacing, `projects`, discover-docs have **no** entry at all. | `CHANGELOG.md:3` | Cut a dated `v0.9.0` heading; add the missing entries. | small |
| D4 | med | Cold-start handoff (the one doc CLAUDE.md tells a fresh agent to read) says v0.8.3/406-tests and names an already-closed ADR-0001 task as top priority. | `docs/handoff/post-v0.8.2-handoff.md:9` | Write a post-v0.8.5 handoff + repoint CLAUDE.md; reconcile the three test-count claims (or use a CI badge). | small |
| D5 | low | No `glean doctor` preflight despite being a planned verb; a missing/un-logged-in `claude` only surfaces per-task at spawn time (`--dry-run` lulls). | `cli.ts:585`, `ROADMAP.md:29` | Ship `glean doctor` (Node version, `claude` on PATH + `-p` auth smoke, git, gh optional, config presence). | medium |

**Refuted (checked, dropped):** "README claims config.json auto-created on first run; it never is" — **false positive**: `cli.ts:45` `ensureDefaultConfig` runs and writes `{claude_bin:'claude'}` on first run (`state.ts:29-35`, tested at `state.test.ts:98-112`). Residual low nit: the scaffold writes only `claude_bin`, not the richer multi-key example — draft-impl still needs a hand-added `base_branch`.

## 3. Low / nice-to-have (batch)

- **uuid ^9 → `node:crypto.randomUUID`** (7 call sites; Node 20 has it native) — drop `uuid` + `@types/uuid`. (`package.json:52`)
- **One `homeDir()` helper** — resolution duplicated in 5 files, `schedule.ts:277` has **reversed** `HOME`/`USERPROFILE` precedence. (latent cross-platform bug)
- **Shared `normalizeSlug`** — `executor.ts:1028` slugify vs `state.ts:26` projectSlug (the slug-ambiguity class already bit this project).
- **zod-validate `budget.json` (DrainState)** in `readDrainState` — currently a bare `JSON.parse … as DrainState` (unlike config.json). (`state.ts:138`)
- **`tsconfig moduleResolution: NodeNext`** (currently `Bundler` for a non-bundled real-ESM pkg — masks missing-`.js` footgun). (`tsconfig.json:5`)
- **STOP log path via `join()`** — hardcoded `\STOP` prints wrong on Linux. (`cli.ts:105`)
- **Stale-weekly-reset edge** — a weekly block whose `resetsAt` already passed is misclassified `session` → re-probes ~5h15m instead of riding out the week. Document as ADR-0003 gap until a real weekly block is captured. (`classify.ts:79-85`)
- **Prune ~23 merged stale local branches** (15 `worktree-agent-*`, 8 `v0.x` tag-duplicates); **note the 2 genuinely-unmerged WIP worktree branches** (`feat/discover-docs-dirs` +4, `feat/nightly-mode` +1) in ROADMAP so they aren't mistaken for noise.
- Optionally fold the `git -C`/`switch`/`branch`/`reset` escape prefixes into `BASE_DENY` and give `fetch-docs` an explicit read-only allow-list for parity (currently safe; allow-list does the work).

## 4. Recommended action plan (waves)

> ✅ = I can do autonomously this session. 🔒 = needs the user (npm login / push are user-gated;
> CLAUDE.md: never push, and "commit/push only when asked"). All work lands on a branch; user pushes/publishes.

**Wave 1 — correctness + the safety-test gap (do before next publish).** ✅
1. F1 gc prep-branch reconstruction via `worktree list --porcelain` + real-UUID test.
2. F2 argv-level deny-list assertions (`BASE_DENY` research, `DRAFT_IMPL_DENY` draft-impl).
3. F4 dashboard loopback-Host + Origin + `isLoopbackHost` tests.
4. F5 cross-day INDEX dedup status semantics (`OK_STATUSES`) + test.
5. F3 PowerShell scheduled-task hardening (whitelist `day`/`time`, marshal paths) + tests.

**Wave 2 — adoption, docs, packaging (makes it "worthy of a stranger's `npm i -g`").** ✅ (publish 🔒)
6. F6 lazy + failure-tolerant `better-sqlite3`/Memory load (so a missing native binding can't kill `glean version`).
7. D5 ship `glean doctor` preflight.
8. D1+D2 README: v0.9 surface + `doctor`, fix stderr→stream-json, prune shipped Coming-next.
9. D3 CHANGELOG: dated v0.9.0 heading + missing entries; bump `package.json` → 0.9.0 (🔒 `npm publish` is the user's).
10. D4 post-v0.8.5 handoff + repoint CLAUDE.md; reconcile test counts across CLAUDE.md/ROADMAP/PROJECT-MAP.

**Wave 3 — architecture + hygiene (no behavior change; reduces regression risk).** ✅
11. F8 export `RATE_LIMIT_RE` from `classify.ts`.
12. Batch the drift/dep fixes: `homeDir()` helper, `normalizeSlug`, `uuid`→`randomUUID`, `moduleResolution: NodeNext`, zod-validate `budget.json`, STOP `join()`.
13. F7 extract `executor.ts` → `spawn-claude.ts` / `draft-git.ts` / `draft-test.ts` (large; behind existing seams).
14. Prune the 23 merged stale branches; record the 2 in-flight WIP worktree branches in ROADMAP.

**Needs the user (not blockers):** `npm publish` (npm login); pushing the branch / opening a PR; the
morning-receipt demo **GIF** (the static hero PNGs already exist and resolve — the GIF is upside, not a fix).

---

*Method: gstack-led planning → superpowers `subagent-driven-development` (worktree-isolated TDD lanes),
the project's own documented pipeline.*

---

## GSTACK REVIEW REPORT

**Skill:** `/plan-eng-review` · **Branch:** `main` · **Repo mode:** solo · **Date:** 2026-06-21

**Scope decision (user):** Execute **all three waves, including F7** (the `executor.ts` split). All work
lands on a feature branch; `npm publish` + `git push` remain user-gated.

| Run | Status | Findings |
|-----|--------|----------|
| Step 0 scope challenge | ✅ done | Plan is ~20 independent fixes, not one feature; built-ins correctly preferred (`randomUUID`, `worktree list --porcelain`, lazy-load over `node:sqlite`). No reinvention. |
| Sequencing risk pass | ✅ done | **F2 must precede F7** — the split moves the `runClaude` code that carries the deny-list (the #1 safety boundary), which no test currently asserts at argv level. F2 is the safety net for the split, not a Wave-1 nicety. |
| Blast-radius pass | ✅ done | F7 (executor split) + F6 (startup lazy-load) are the only high-regression-risk items; both on hot paths. Do DRY consolidations first → F7 becomes a mechanical pure-move, verified by 697 tests + F2. |
| Boring-by-default pass | ✅ done | F6 = lazy-load + try/catch (reversible, matches existing `cli.ts` pattern), **not** the `node:sqlite` migration (would force an engine bump). |
| ADR-discipline pass | ✅ done | The stale-weekly-reset edge (`classify.ts:79-85`) is **document-only** — fixing it on the unverified weekly signal is the ADR-0001 trap. Leave the tripwire; supersede when a real block is captured. |

**Execution contract (ordering):**
1. **Phase 1 (parallel, file-disjoint):** F1+F5 (gc + dedup); F3 (PowerShell hardening); F2+F4 (safety/dashboard tests).
2. **Phase 2 (sequential, shared hot files):** F8 + DRY batch (RATE_LIMIT_RE export, homeDir, normalizeSlug, uuid→randomUUID, NodeNext, zod budget.json, STOP join) → F6 (lazy sqlite) + D5 (glean doctor) → **F7 (executor split, last, guarded by F2)**.
3. **Phase 3 (docs):** D1–D4 README/CHANGELOG/handoff/test-counts + version→0.9.0.
4. Prune 23 merged stale branches; note the 2 WIP worktree branches in ROADMAP.

Each phase gated by the full `npm test` suite (697 baseline) + `npm run lint` + `npm run build`.
Subagents develop under superpowers (TDD + verification-before-completion).

**VERDICT: APPROVED — proceed with the full plan in the phased order above.** The plan is well-scoped
and low-reinvention; the only material risk is the executor split, which the F2-before-F7 ordering
neutralizes. No scope reduction required (user opted for the complete set).
