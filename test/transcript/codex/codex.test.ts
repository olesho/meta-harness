import { expect, test } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { CodexReader } from "../../../src/transcript/codex/codex.ts"
import { tempDir } from "../tmp.ts"

test("read against fixture", () => {
  const dir = tempDir()
  const root = path.join(dir, "sessions", "2026", "05", "14")
  mkdirSync(root, { recursive: true })
  const body = `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}
{"type":"other"}
`
  writeFileSync(path.join(root, "rollout-2026-05-14T12-00-00-abc-def-ghi.jsonl"), body)

  const r = new CodexReader(path.join(dir, "sessions"))
  const turns = r.read("abc-def-ghi", "/unused")
  expect(turns).toHaveLength(2)
  expect(turns[0]!.role).toBe("user")
  expect(turns[0]!.text).toBe("hello")
  expect(turns[1]!.role).toBe("assistant")
  expect(turns[1]!.text).toBe("hi there")
})

test("read missing session errors", () => {
  const r = new CodexReader(tempDir())
  expect(() => r.read("missing", "")).toThrow()
})
