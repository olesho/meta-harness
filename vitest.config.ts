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
    // Each PTY-backed test cold-spawns one or more fresh `node` processes (the
    // PTY bridge, the `#!/usr/bin/env node` fake harness, and sometimes an extra
    // CLI subprocess). On a CPU-contended release-gate host a single cold
    // `node` + ESM resolution can reach ~3 s, so the sum of spawns easily blows
    // vitest's 5000 ms default. Give every test generous global headroom so the
    // whole suite inherits it instead of relying on piecemeal per-file overrides
    // (META-HARNESS-79; prior fixes patched budgets one file at a time, which is
    // why the failing test rotated each gate run).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
