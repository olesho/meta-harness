import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The suite drives real PTYs and asserts on wall-clock idle/timing
    // thresholds. Running test files concurrently starves those timers and
    // makes the PTY tests flaky, so run files sequentially (mirrors how the
    // former `bun test` runner exercised them).
    fileParallelism: false,
  },
});
