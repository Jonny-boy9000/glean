# Draft implementation task

You are working in an **isolated git worktree** on a throwaway `prep/glean-*`
branch. Your job is to produce a **speculative draft** for review — not a
finished, mergeable change.

## The task

{{title}}

Evidence (the TODO/FIXME to address):

```
{{evidence.file_excerpt}}
```

File: `{{evidence.file}}`

## What to do

1. Implement the single TODO/FIXME above. Keep the change focused — do not
   refactor unrelated code.
2. If the project has a test command (e.g. `npm test`, `pytest`, `cargo test`),
   run it. Surface the result; do not spend the whole budget chasing green.
3. Commit your work with a scoped `git add <the files you changed>` (never
   `git add -A`) followed by a commit. Use a clear message.

## Hard rules

- Stay inside this worktree. Do NOT switch branches, reset refs, or touch the
  user's `main` checkout. Never push and never open or merge a PR.
- Commit only the files you intentionally changed. Do not commit scratch or
  prompt files.
- An honest "draft, tests red" branch is acceptable and useful. Do not fake a
  passing result.

Do NOT write an `OUT.md` — your output IS the committed branch.
