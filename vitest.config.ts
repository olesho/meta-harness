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
  },
});
