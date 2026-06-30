import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  all,
  pinned,
  readFrom,
  errEmptyPackage,
  errEmptyBinary,
  errVerifiedAtWithoutPinned,
  errParse,
  errRead,
} from "../../src/versions/index.ts"
import { isSentinel, type Sentinel } from "../../src/internal/async/index.ts"

function tmpVersions(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "versions-"))
  const path = join(dir, "versions.json")
  writeFileSync(path, body)
  return path
}

function expectSentinel(fn: () => unknown, sentinel: Sentinel): void {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeDefined()
  expect(isSentinel(thrown, sentinel)).toBe(true)
}

describe("versions", () => {
  test("all and pinned against the embedded repo file", () => {
    const entries = all()
    for (const want of ["codex", "claude-code", "gemini", "opencode", "pi"]) {
      const entry = entries.get(want)
      expect(entry).toBeDefined()
      expect(entry!.binary).not.toBe("")
    }

    {
      const [got, ok] = pinned("codex")
      expect(ok).toBe(true)
      expect(got).not.toBe("")
    }
    {
      const [, ok] = pinned("nonexistent")
      expect(ok).toBe(false)
    }
    // Gemini is intentionally unpinned in the initial versions.json.
    expect(pinned("gemini")[1]).toBe(false)
    // OpenCode is likewise unpinned until a corpus pins its version.
    expect(pinned("opencode")[1]).toBe(false)
    // pi is pinned: its adapter/profile are verified against a committed corpus.
    {
      const [got, ok] = pinned("pi")
      expect(ok).toBe(true)
      expect(got).not.toBe("")
    }
    // claude-code's harness key differs from its on-PATH binary name; the
    // binary field is what discovery probes against.
    expect(all().get("claude-code")!.binary).toBe("claude")
  })

  test("readFrom rejects empty package", () => {
    const path = tmpVersions(`{"foo":{"package":"","binary":"foo","pinned":"1.0.0"}}`)
    expectSentinel(() => readFrom(path), errEmptyPackage)
  })

  test("readFrom rejects empty binary", () => {
    const path = tmpVersions(`{"foo":{"package":"pkg","binary":"","pinned":"1.0.0"}}`)
    expectSentinel(() => readFrom(path), errEmptyBinary)
  })

  test("readFrom rejects verified_at without pinned", () => {
    const path = tmpVersions(
      `{"foo":{"package":"pkg","binary":"foo","pinned":"","verified_at":"2026-05-15"}}`,
    )
    expectSentinel(() => readFrom(path), errVerifiedAtWithoutPinned)
  })

  test("readFrom on a missing file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "versions-")), "nope.json")
    expectSentinel(() => readFrom(path), errRead)
  })

  test("readFrom on malformed JSON", () => {
    const path = tmpVersions(`not json`)
    expectSentinel(() => readFrom(path), errParse)
  })
})
