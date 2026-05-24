# Pre-fetch docs: {{evidence.package}}

The user recently added `{{evidence.package}}` to `{{evidence.manifest}}`
({{evidence.added_at}}). Pre-fetch the most useful documentation so they
can read it offline next session.

## Task
1. Use the context7 MCP: resolve the library id, then fetch docs.
2. Write the docs to `docs/{{evidence.package | slug}}.md` in the current
   working directory.
3. Add a 5-line "what's covered" preamble at the top.

## Rules
- Read-only operation. No code edits.
- If context7 cannot resolve the library, write a one-paragraph note in
  `docs/{{evidence.package | slug}}.md` explaining the failure.
