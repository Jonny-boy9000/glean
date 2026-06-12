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
{{else if evidence.kind == "doc"}}
- Planning doc: `{{evidence.file}}` (line {{evidence.line}}, under heading "{{evidence.heading}}")
- Planned item: {{evidence.item_text}}
- This item was written by the project's own author into a roadmap/plan/handoff
  document — treat it as explicit intent. Read `{{evidence.file}}` (and any
  documents it references) in the project for the full surrounding context
  before researching.
{{/if}}

## Task
Your **final message** must be the dossier itself, with these sections:
1. **One-paragraph summary** — what this is and what the user should do next.
2. **Findings** — 3–7 concrete observations from reading the code/context.
3. **Suggested next actions** — ranked, each with the specific file/line.
4. **Open questions** — what you couldn't determine without running the code.

## Rules
- Speculative work only. Do NOT make production-affecting changes.
- You are **read-only**: read the project freely, but you have no write/edit tools.
  Do NOT write any files — glean captures your final message as the dossier.
- Do NOT run `git push`, `git checkout main`, or any `gh pr` mutation.
- If you cannot do useful work, make your final message a one-paragraph
  explanation of why.
