// R7 regression: resolveHost() picks the PTY bridge. META_HARNESS_PTY_HOST lets a
// consumer that bundles/relocates the wrapper (so import.meta.url no longer sits
// next to ptyHost.mjs) point at the bridge's real location. Resolved lazily at
// spawn time, so a plain env set (no import-order dance) takes effect.

import { afterEach, describe, expect, test } from "vitest"
import { resolveHost } from "../../src/wrapper/internal/pty.ts"

const KEY = "META_HARNESS_PTY_HOST"
const original = process.env[KEY]
afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
})

describe("resolveHost (META_HARNESS_PTY_HOST override)", () => {
  test("defaults to ptyHost.mjs next to the module when unset", () => {
    delete process.env[KEY]
    expect(resolveHost().endsWith("/ptyHost.mjs")).toBe(true)
  })

  test("honors an absolute override", () => {
    process.env[KEY] = "/opt/bundle/dist/ptyHost.mjs"
    expect(resolveHost()).toBe("/opt/bundle/dist/ptyHost.mjs")
  })

  test("ignores a blank/whitespace override and falls back to default", () => {
    process.env[KEY] = "   "
    expect(resolveHost().endsWith("/ptyHost.mjs")).toBe(true)
  })
})
