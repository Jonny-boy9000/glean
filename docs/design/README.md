# Design history (mirrored from the gstack project store)

These files are **mirrored copies** of the office-hours design docs and plan-eng-review test
plans that gstack writes to the machine-local store at
`%USERPROFILE%\.gstack\projects\Jonny-boy9000-glean\` (which is **not** version-controlled).

They are committed here so the project's design history is **clone-portable** — a fresh checkout
on another machine no longer loses the canonical drain design or the eng-review test plans that
in-repo handoffs reference. (Resolves strategic-review item **R1** in
[`../PROJECT-MAP.md`](../PROJECT-MAP.md).)

| File | What it is |
|------|-----------|
| `user-main-design-20260601-115052.md` | v0.7-era design (draft-impl + first drain-core sketch). |
| `user-main-design-20260601-195916.md` | **v0.8.0 drain core** — the canonical drain design (exit-and-re-enter, classifier, re-entry guard). |
| `user-main-design-20260602-090419.md` | v0.8.1 UX polish (work-week schedule, RECEIPT.md, README; D7 = today/peek). |
| `user-main-eng-review-test-plan-20260601-120000.md` | v0.7 eng-review test plan. |
| `user-main-eng-review-test-plan-20260602-000000.md` | **v0.8 drain** eng-review test plan (affected surfaces, key interactions, edge cases). |
| `gstack-learnings.jsonl` | Cross-session learnings (e.g. the "no in-process sleep on a laptop" pitfall). |

## Keeping these current

These are **snapshots**, not live links. When gstack writes a new design doc or eng-review test
plan for a release (via `/office-hours` / `/plan-eng-review`), copy the new file here as part of
that release's commit, and update the table above + [`../PROJECT-MAP.md`](../PROJECT-MAP.md) §5.
The authoritative *working* copies remain in the gstack store; these are the portable record.
