# ADR-0004 — Per-task timeout: wall-clock deadline polling + bounded kill grace

- Status: **Accepted** (root cause verified against live evidence + the Windows event log)
- Date: 2026-06-12
- Enforced at: `src/lib/executor.ts` (`runClaude`: `deadlineTimer` interval, `issueKill`, the
  `KILL_GRACE_EXPIRED` force-resolve, `descendantsDead`), `src/lib/jobobject.ts` (`terminateTree`
  seam; `kill()` carries the `INVARIANT[ADR-0004]` "may never resolve" warning); tests: the two
  `ADR-0004` tests in `src/lib/executor.test.ts`, fixture `test/fixtures/scenarios/wedged.yaml`.

## Context

Live run `2026-06-12-1711-41b981` (`--budget 15m`, default `--task-timeout 8m`): task
`0e4a41bc` started 14:13:51Z and ended 14:48:22Z — `elapsed_ms` 2,070,996 (34.5 min) with status
`timeout`; the run overran its budget to 37 min. The initial reading was "the kill fired at 8 min
and the child survived 26 more minutes."

The verified timeline says otherwise:

- The captured stream's last normal event is **14:15:44Z**; the Kernel-Power event log shows the
  machine **entered S3 sleep at 14:15:45Z and resumed at 14:48:10Z** (the kernel clock resync
  event records the 32.4-min gap exactly).
- The stream's final 3 lines are `api_retry` events with `error:"unknown"` /
  `error_status:null` — the wedged-network shape right after resume — and the file stops
  **mid-retry-batch (attempt 3 of 10, no result event)**: an abrupt external kill.
- `task.end` is 14:48:22.852Z, ~12 s after resume.

So the timeout **did** kill the tree, and quickly — *once it finally fired*. The single
`setTimeout(taskTimeoutMs)` could not fire while the machine slept, and the fact that the overdue
timer fired ~immediately on resume is **platform luck** (libuv's loop clock happening to include
the slept interval), not a contract. A separate clean repro confirmed `taskkill /T /F` does kill
the real `cmd /c claude.cmd → claude.exe` tree shape in ~250 ms.

Two real gaps fell out of the investigation:

1. **The deadline source was a timer, not the clock.** Across sleep/resume the kill can land
   arbitrarily late (and on platforms where the loop clock excludes sleep, up to the full
   remaining timeout of *awake* overrun). Scheduled weekend drains on a sleeping laptop hit this
   constantly — it is glean's primary deployment shape.
2. **A failed kill wedges the executor forever.** `Job.kill()` resolves only after the child
   exits; `runClaude` awaited `job.exit` unconditionally. taskkill errors are deliberately
   swallowed (best effort), so any kill that doesn't take the child down (access denied, pid
   race, an orphan holding on) would pin the run with no bound at all.

## Decision

1. **The per-task deadline is enforced against the wall clock** (`Date.now()`), polled every
   250 ms (`TIMEOUT_POLL_MS`), instead of a single `setTimeout`. After any sleep/resume or clock
   jump the kill fires within ~one poll interval of the process being runnable again. (While the
   machine is asleep nothing can run — no design can kill sooner than resume.)
2. **Every kill gets a bounded grace** (`killGraceMs`, default 5 s — `ExecCtx.killGraceMs` to
   override). If the child has not exited within the grace, `runClaude` force-resolves with the
   status the kill was issued for (`timeout` / `rate-limit`), detaches + destroys its pipe ends,
   `unref()`s the child, and reports `descendantsDead: false` so worktree cleanup (F7) never
   touches a lock a live straggler might hold. Timeout and rate-limit kills share one
   `issueKill` path, so the grace covers both.
3. **`Job.kill()`'s contract is documented as "may never resolve"** (it awaits the child's
   exit); callers must bound their wait. The platform terminate request is an injectable seam
   (`__terminateTree.impl`) so tests can simulate a kill that fails.

`elapsed_ms` stays honest wall-clock (a slept-through task still records the real span); the
budget can still be overrun by the sleep itself — only awake overrun is now bounded.

## Status / what would change this

If a real `claude -p` tree ever survives `taskkill /T /F` while the machine is awake (the
originally-suspected failure), the force-resolve bounds the run but leaks the tree — capture the
survivor's process shape and revisit a Windows Job Object (the module's namesake) for kill
enforcement. A monotonic-clock deadline (`process.hrtime`) was rejected because monotonic-vs-sleep
semantics are exactly the platform-dependent swamp being escaped; `Date.now()` is the only source
that tracks the wall by definition.
