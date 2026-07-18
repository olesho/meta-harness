import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Prepend a real `node` to PATH before any test runs, so the PTY bridge and
    // the `#!/usr/bin/env node` fake harness resolve even in an nvm-less gate
    // shell (META-HARNESS-34). Mirrors bunfig.toml's `[test] preload` for the
    // gate's `bun test`.
    setupFiles: ["./test/setup/ensure-node-on-path.ts"],
    // The suite drives real PTYs and asserts on wall-clock idle/timing
    // thresholds. Running test files concurrently starves those timers and
    // makes the PTY tests flaky, so run files sequentially (mirrors how the
    // former `bun test` runner exercised them).
    fileParallelism: false,
    // Isolate each test file in its own forked process rather than the default
    // shared worker, so per-file memory — coverage instrumentation plus the
    // PTY/child handles these tests spawn — is freed between files instead of
    // accumulating into a "JavaScript heap out of memory" crash on CI (where
    // the default heap is smaller than on dev machines). Verified: the full
    // suite and the coverage run both pass with the fork heap capped at 512MB.
    pool: "forks",
  },
});
