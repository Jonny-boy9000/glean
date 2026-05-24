# Research dossier: {{title}}

You are doing speculative prep work between Claude Code sessions. Produce a
focused research note that will save the user time when they next sit down
to work on this.

## Context
- Project: {{project_path}}
- Evidence type: {{evidence.kind}}
{{#if evidence.kind == "todo"}}
- TODO source: `{{evidence.file}}` (lines: {{evidence.todo_lines | join_lines}})
- Surrounding code (≤200 lines):
```
{{evidence.file_excerpt}}
```
{{else if evidence.kind == "pr"}}
- Open PR #{{evidence.number}}: {{evidence.title}} ({{evidence.url}})
- Unresolved review comments:
{{evidence.review_comments | bullet_list}}
{{else if evidence.kind == "jsonl"}}
- Last session title: {{evidence.ai_title}}
- Session was idle {{evidence.idle_hours}}h
- Recent assistant turns (last 3, trimmed):
{{evidence.recent_turns | quote}}
{{/if}}

## Task
Write `OUT.md` in the current working directory with these sections:
1. **One-paragraph summary** — what this is and what the user should do next.
2. **Findings** — 3–7 concrete observations from reading the code/context.
3. **Suggested next actions** — ranked, each with the specific file/line.
4. **Open questions** — what you couldn't determine without running the code.

## Rules
- Speculative work only. Do NOT make production-affecting changes.
- Do NOT run `git push`, `git checkout main`, or any `gh pr` mutation.
- Read freely; write only `OUT.md` in the current working directory.
- If you cannot do useful work, write a one-paragraph `OUT.md` explaining why.
