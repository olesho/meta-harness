// Test preload / setup: guarantee a real `node` is on PATH before any test runs.
//
// META-HARNESS-34 — the release gate runs the suite in a headless/cron shell
// where nvm hasn't populated PATH, so `node` is absent. Every PTY-backed test
// then fails: the wrapper spawns a `node ptyHost.mjs` bridge and the fake harness
// is a `#!/usr/bin/env node` script — both need a resolvable `node`. One PATH
// mutation here fixes all of them, because the bridge inherits `process.env` and
// the fake harness derives its env from `process.env`.
//
// Wired in two places so it runs first regardless of the launcher:
//   • `bunfig.toml`  → `[test] preload` (the gate's `bun test`)
//   • `vitest.config.ts` → `setupFiles` (`npm test` / `vitest run`)
//
// If no interpreter resolves, throw a single actionable error so the gate fails
// loudly with the real cause instead of emitting dozens of opaque PTY failures.

import { delimiter, dirname } from "node:path";

import { findNode } from "../../src/wrapper/internal/pty.ts";

const node = findNode();
if (!node) {
  throw new Error(
    "bun test requires a `node` interpreter for the PTY bridge; none found — " +
      "add node to PATH or set META_HARNESS_NODE",
  );
}

const dir = dirname(node);
const current = process.env.PATH ?? "";
if (!current.split(delimiter).includes(dir)) {
  process.env.PATH = current ? `${dir}${delimiter}${current}` : dir;
}
