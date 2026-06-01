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

export const DRAFT_IMPL_DENY = [BASE_DENY, SWITCH, BRANCH, RESET, WORKTREE].join(' ');
