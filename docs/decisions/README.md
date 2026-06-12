# Decision records (ADRs)

Lightweight, immutable records of **load-bearing decisions and the assumptions they rest on** —
so the research and rationale behind a choice can't be silently lost, and so a future session
can't "improve" a subsystem without seeing why it is the way it is.

This exists because of a concrete near-miss (see `0001`): a load-bearing assumption ("the
rate-limit signal is X") was stated as a fact in a comment and a memory, with its *evidence
boundary* left implicit. A later session read the rationale and still drew the wrong conclusion,
because nothing said **which part was verified and which part was a guess.**

## The three layers (where each thing lives)

| Question | Where | Rule |
|----------|-------|------|
| **WHAT is assumed / must not change** | a terse tagged comment **at the code site** | `ASSUMPTION[ADR-NNNN]` / `INVARIANT[ADR-NNNN]`, with `UNVERIFIED` if it's a guess |
| **WHY** (research, alternatives, data, dead-ends) | an ADR here, linked from the comment by ID | immutable; **supersede, don't edit** |
| **ENFORCEMENT** (so a break trips) | a test that encodes the assumption | named after the ADR when it guards an open question |

The code→ADR link is the anti-drift mechanism: edit either and you find the other.

## When to write an ADR

- A decision is **load-bearing** (other code/behavior depends on it being true).
- A decision rests on an **unverified assumption** (the dangerous kind — mark it `UNVERIFIED` loudly).
- You **reverse or supersede** a prior decision (write a new ADR, set the old one's status to `Superseded by NNNN`; never delete).

Do **not** write an ADR for routine, reversible, or self-evident choices. This is for the handful
of things that, if a future editor gets them wrong, break the product quietly.

## Format (keep it ~15-30 lines)

```
# ADR-NNNN — <title>

- Status: Proposed | Accepted | UNVERIFIED | Superseded by NNNN | Deprecated
- Date: YYYY-MM-DD
- Enforced at: <file:symbol> (tagged ASSUMPTION[ADR-NNNN]) + <test name>
- Supersedes / Superseded by: <ADR id, if any>

## Context
<the situation + what's actually verified vs. assumed — be explicit about the evidence boundary>

## Decision
<what we do, and why this over the alternatives>

## Status / what would change this
<for UNVERIFIED: exactly what evidence flips it, and how that evidence gets captured>
```

## The verified/assumed discipline (the actual lesson)

State assumptions in the **conditional**, not the indicative. A comment that says
`// the block signal is stderr` reads as fact. `// ASSUMPTION[ADR-0001] UNVERIFIED — block signal
is a GUESS; never observed` stops the next editor cold. **An assumption stated as a fact is the trap.**

For an agent/session: a finding that *overturns a prior decision* is a **hypothesis to disprove**,
not a conclusion — verify the negative case before asserting (see `CLAUDE.md` → "Decision records").

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](./0001-rate-limit-signal-source.md) | Rate-limit signal source (stderr vs. stream-json `rate_limit_event`) | Superseded by 0003 |
| [0002](./0002-dossier-project-read-scope.md) | Research-dossier sessions get read-scope to the project | **Accepted** (validated by the 2026-06-11 live drain: 9/16 dossiers repo-grounded) |
| [0003](./0003-structured-stream-json-block-signal.md) | Rate-limit block signal: structured stream-json 429 | **Accepted** (session shape verified; weekly still unobserved) |
| [0004](./0004-wall-clock-task-deadline-and-bounded-kill-grace.md) | Per-task timeout: wall-clock deadline + bounded kill grace | **Accepted** (sleep/resume root cause verified) |
| [0005](./0005-model-weight-multipliers.md) | Model-family weight multipliers for pacing (haiku 0.25 / sonnet 1 / opus 5) | **UNVERIFIED** (consistency over truth) |
| [0006](./0006-internal-usage-loader.md) | Internal JSONL usage loader (ccusage/data-loader unavailable upstream) | **Accepted** |
