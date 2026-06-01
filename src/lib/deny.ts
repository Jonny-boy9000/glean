// Centralized claude -p --disallowedTools deny-lists (T4).
//
// These are load-bearing safety constraints from CLAUDE.md. Spawned sessions
// run with subscription auth against the user's machine; the deny-list is the
// in-session guard that stops a runaway model from publishing or rewriting refs.
// Worktree isolation is the *real* guarantee (git refuses to let a linked
// worktree mutate another worktree's HEAD); this list is defense-in-depth.

// Blocked on EVERY spawn (dossier, fetch-docs, draft-impl):
const PUSH = 'Bash(git push:*)';            // never publish to a remote
const CHECKOUT_MAIN = 'Bash(git checkout main:*)'; // never move the main worktree onto main
const PR_MERGE = 'Bash(gh pr merge:*)';     // never merge a PR
const PR_CREATE = 'Bash(gh pr create:*)';   // never open a PR

export const BASE_DENY = [PUSH, CHECKOUT_MAIN, PR_MERGE, PR_CREATE].join(' ');

// Extra prefixes for the draft-impl path, which is the first Glean path that
// runs Bash + git inside a worktree. These close ref-mutation bypass holes the
// BASE_DENY misses:
const SWITCH = 'Bash(git switch:*)';        // `git switch main` sidesteps the checkout-main block
const BRANCH = 'Bash(git branch:*)';        // `git branch -f` / -D can move or delete refs
const RESET = 'Bash(git reset:*)';          // `git reset --hard <ref>` can move a branch
const WORKTREE = 'Bash(git worktree:*)';    // never add/remove/move worktrees from inside a session
// Escape forms that re-target git at the user's main checkout / another repo.
// `git -C <main> push`, `git --git-dir=<main>/.git reset`, etc. would slip past
// the verb-prefix blocks above because the dangerous verb is no longer the first
// token. These deny entries are defense-in-depth; the REAL boundary is the
// scoped allow-list below (CRITICAL 1) — bare `Bash` is never granted, so the
// only Bash the model can run is the explicitly allow-listed verb set, and
// `git -C` / `--git-dir` / `--work-tree` are simply not in that set.
const GIT_C = 'Bash(git -C:*)';             // `git -C <other-repo> ...` re-targets git elsewhere
const GIT_DIR = 'Bash(git --git-dir:*)';    // `git --git-dir=... ...` re-targets the object store
const WORK_TREE = 'Bash(git --work-tree:*)'; // `git --work-tree=... ...` re-targets the working tree

export const DRAFT_IMPL_DENY = [BASE_DENY, SWITCH, BRANCH, RESET, WORKTREE, GIT_C, GIT_DIR, WORK_TREE].join(' ');

// ── Scoped allow-list for draft-impl (CRITICAL 1) ───────────────────────────
// The draft-impl spawn must NEVER pass bare `Bash` (wholesale shell). A bare
// `Bash` grant lets the model run `git -C <main> push`, `rm -rf <main>`, or
// `echo x > <main>/file` — none of which a prefix deny-list can fully block.
// Instead we grant the MINIMAL allow-list empirically proven by the T1 re-spike:
// Edit + Write (scoped to the worktree via --add-dir) plus exactly the git
// commit-cycle verbs the model needs to stage/commit its own draft, plus a
// per-project test-command set. Anything not on this list is denied by default,
// so a re-targeted `git -C`, a raw `rm`, or a stray `curl` simply cannot run.
//
// Capability/safety tradeoff: a tighter list means a more capable model is
// occasionally blocked from a legitimate helper command (e.g. `git log`), which
// it can route around. We accept that in exchange for a hard, allow-list-shaped
// boundary around the user's main checkout — the load-bearing invariant.
const DRAFT_IMPL_GIT_ALLOW = [
  'Bash(git add:*)',     // stage intended changes
  'Bash(git commit:*)',  // commit the draft
  'Bash(git status:*)',  // inspect the working tree
  'Bash(git diff:*)',    // inspect changes
] as const;

// Default test-command prefixes (Node/TS projects). Per-project overrides come
// from config.json `projects[path].test_command`; see config.ts.
export const DEFAULT_TEST_COMMAND_ALLOW = [
  'Bash(npm test:*)',
  'Bash(npm run:*)',
  'Bash(npx vitest:*)',
  'Bash(node:*)',
] as const;

// Build the draft-impl --allowedTools string from the fixed Edit/Write + git
// commit-cycle set plus the caller-supplied test-command prefixes.
export function draftImplAllowedTools(testCommandAllow: readonly string[]): string {
  return ['Edit', 'Write', ...DRAFT_IMPL_GIT_ALLOW, ...testCommandAllow].join(' ');
}

// Normalize a per-project `test_command` (config.json) into a scoped Bash
// allow-prefix. A blank/absent command falls back to the npm/node default set.
// e.g. "pytest" → ["Bash(pytest:*)"], "cargo test" → ["Bash(cargo test:*)"].
export function testCommandAllowFor(testCommand: string | undefined): readonly string[] {
  const cmd = testCommand?.trim();
  if (!cmd) return DEFAULT_TEST_COMMAND_ALLOW;
  return [`Bash(${cmd}:*)`];
}
