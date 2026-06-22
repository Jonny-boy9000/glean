import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 45_000,
    hookTimeout: 45_000,
    // Many suites spawn REAL subprocesses (fake-`claude` via `node`, draft-impl
    // git worktrees, live HTTP servers in serve.test.ts). At full file
    // parallelism (~1 worker per core) those real spawns oversubscribe the box
    // and starve each other — an individual real-spawn/real-HTTP test can stall
    // past even a 45s timeout while peers hog the cores, producing a flaky
    // failure on a *different* timing test each run (never the same one twice).
    // The work here is subprocess-I/O-bound, not CPU-logic-bound, so capping the
    // pool keeps throughput reasonable while making the suite deterministic on a
    // busy laptop or loaded CI box. See docs/reviews/2026-06-21 (slow-real-spawn
    // -tests finding).
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
  },
});
