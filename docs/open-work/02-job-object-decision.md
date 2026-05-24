# Task 2: Windows Child-Process Tree Kill — Approach Decision

**Date:** 2026-05-24  
**Status:** DECIDED — use `taskkill /T /F`  
**Relevant plan task:** Task 14 (`lib/jobobject.ts`)

---

## Background

Glean runs shell commands as child processes. When a step times out or the pipeline is
cancelled, all descendants of that child must be killed — not just the immediate child.
On Unix this is straightforward (`process.kill(-pgid, 'SIGKILL')`). On Windows the
equivalent mechanism is more nuanced. This spike evaluated three candidate approaches
before Task 14 commits to one.

---

## Approaches Evaluated

### Option A — `taskkill /T /F` (ships with Windows, no dep)

`taskkill` is a built-in Windows utility available on every supported Windows version
(Vista+). The `/T` flag kills the entire process tree rooted at the target PID; `/F` forces
termination without waiting for cooperative shutdown.

**Spike test:** Spawned `cmd /c ping -n 100 127.0.0.1` (a parent cmd.exe that itself
spawned ping.exe as a grandchild). After 1 s, called:

```
taskkill /PID <child-pid> /T /F
```

**Observed output:**

```
SUCCESS: The process with PID 3708 (child process of PID 27372) has been terminated.
SUCCESS: The process with PID 39016 (child process of PID 27372) has been terminated.
SUCCESS: The process with PID 27372 (child process of PID 41272) has been terminated.
```

Three processes died: the target cmd.exe (27372), ping.exe (3708, grandchild), and
conhost.exe (39016, console host). Post-kill `tasklist /FI "PID eq <pid>"` returned "No
tasks are running which match the specified criteria." — confirmed gone.

**Exit notification:** Node.js `child.on('exit')` fired with code=1 within the same
500 ms window as the taskkill call, well before the 0.5 s post-check. No zombie
lingering observed. Pipes closed promptly.

**taskkill exit code:** 0 (success). Non-zero exit (e.g. 128) means PID not found —
process already exited, which is a benign race condition that should be swallowed.

**Install footprint:** Zero — binary is at `%SystemRoot%\System32\taskkill.exe`.

---

### Option B — `windows-kill` npm package

**Result: FAILED TO INSTALL.**

`npm i --no-save windows-kill` triggered a native compile step via `node-pre-gyp`. The
install script (`scripts/install.js`) threw:

```
Error: An issue occured during installing native module.
```

Additional signals of staleness: the package depends on `node-pre-gyp@0.9.1` (the
non-scoped, deprecated version), `tar@4.4.19`, `rimraf@2.7.1`, `osenv@0.1.5` — all
deprecated or vulnerable. The package has not been updated to support Node 24 (current
version in this environment: v24.12.0).

**Conclusion:** `windows-kill` is abandoned and cannot be relied upon. Even if a native
build succeeded in some environments, requiring a native compile step breaks the
zero-native-dependency goal for the MVP.

---

### Option C — Custom N-API Job Object module

Write a custom native addon that wraps the Win32 `CreateJobObject` / `AssignProcessToJobObject`
APIs. Gives the most control (can set CPU/memory limits, receive notifications on
process exit, etc.) but requires:

- Writing and maintaining C++ / N-API code
- A compile step in CI for each Node ABI + platform
- Significant implementation time (~2–3 days vs 30-min spike)

**Conclusion:** Out of scope for MVP. Deferred to a post-v1 enhancement if Glean ever
needs resource limits or fine-grained process lifecycle events.

---

## Decision

**Use `taskkill /T /F` via `node:child_process.spawn`.**

Rationale:
1. Empirically confirmed to kill grandchildren in a real process tree (ping.exe died
   alongside its parent cmd.exe).
2. Zero additional dependency — no npm install, no native compile, no version pinning.
3. Ships on every supported Windows version.
4. Exit notification arrives promptly; no leftover pipes or zombie processes observed.
5. The only viable alternative (`windows-kill`) fails to install on Node 24.

---

## Edge Cases and Gotchas

| Scenario | Behaviour | Mitigation |
|---|---|---|
| Child already exited by the time kill is called | `taskkill` exits with code 128, stderr: "The process X not found." | Swallow exit code 128 in the kill wrapper. |
| Kill returns before child's stdio pipes are fully flushed | Possible — taskkill sends termination signal; pipe closure is asynchronous. | In `jobobject.ts`, wait for `child.on('exit')` after calling kill rather than treating taskkill's exit as the signal that stdio is drained. |
| Process re-parents (orphan grandchild before kill) | A grandchild that calls `CreateProcess` and then the parent exits before we kill can escape the tree. | Acceptable for MVP — no known glean use-case spawns processes that re-parent. Document as known limitation. |
| Elevated child processes | `taskkill /F` cannot kill a child running at higher integrity than the caller. | Document as a known limitation; glean commands should not run as administrator. |
| Very fast child exit (race) | Child exits after PID is captured but before `spawn('taskkill', ...)` runs. | Benign — taskkill exit 128. Swallow. |

---

## What This Means for Plan Task 14 (`lib/jobobject.ts`)

Task 14 will implement a `killTree(pid: number): Promise<void>` helper. Based on this
spike, the implementation strategy is:

```ts
// lib/jobobject.ts
import { spawn } from 'node:child_process';

/**
 * Kill a Windows process tree rooted at `pid`.
 * Uses `taskkill /T /F` — ships on all Windows versions, no extra dep.
 * Resolves when taskkill has terminated. The caller should additionally
 * await child.on('exit') to know that stdio pipes have closed.
 */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
    });
    killer.on('exit', (code) => {
      if (code === 0 || code === 128) {
        // 0  = success; 128 = PID not found (already dead) — both are OK
        resolve();
      } else {
        reject(new Error(`taskkill exited with code ${code}`));
      }
    });
    killer.on('error', reject);
  });
}
```

Key implementation notes:
- No npm dependency to add. No package.json change required.
- The module name `jobobject.ts` can stay as-is (it's the right abstraction boundary
  for OS-specific process management) even though we're not using the Win32 Job Object
  API in the MVP.
- On non-Windows platforms (if glean ever targets them), swap this implementation for
  `process.kill(-pid, 'SIGKILL')` behind an `os.platform()` guard.
- Unit-test the happy path with a real child process in the integration test suite
  (Task 20+); mock `spawn` for the unit test.

---

## Install Command

None. `taskkill` requires no installation.

## Version Pin

None required — `taskkill` is a Windows OS binary, not a versioned package.
