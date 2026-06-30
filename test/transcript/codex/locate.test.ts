import { expect, test } from "bun:test"
import {
  mkdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { CodexReader } from "../../../src/transcript/codex/codex.ts"
import { tempDir } from "../tmp.ts"

// writeRollout writes a minimal rollout whose first line is a session_meta
// envelope, then stamps the file mtime so locator ordering is deterministic.
function writeRollout(
  root: string,
  sessionID: string,
  cwd: string,
  mtimeSec: number,
): string {
  const dir = path.join(root, "2026", "06", "26")
  mkdirSync(dir, { recursive: true })
  const body = `{"timestamp":"2026-06-26T05:25:23.303Z","type":"session_meta","payload":{"session_id":"${sessionID}","cwd":"${cwd}","cli_version":"0.142.0"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}
`
  const p = path.join(dir, "rollout-2026-06-26T07-25-23-" + sessionID + ".jsonl")
  writeFileSync(p, body)
  utimesSync(p, mtimeSec, mtimeSec)
  return p
}

test("picks newest matching cwd", () => {
  const root = tempDir()
  const cwd = "/work/project"
  const base = 1781420400 // 2026-06-26T07:00:00Z

  writeRollout(root, "00000000-0000-0000-0000-000000000001", cwd, base)
  const want = "00000000-0000-0000-0000-000000000002"
  writeRollout(root, want, cwd, base + 120)
  writeRollout(root, "00000000-0000-0000-0000-000000000003", "/other/dir", base + 300)

  const got = new CodexReader(root).locateLatestSession(cwd)
  expect(got).toBe(want)
})

test("no match returns undefined", () => {
  const root = tempDir()
  writeRollout(root, "00000000-0000-0000-0000-000000000001", "/some/where", 1781420400)
  expect(new CodexReader(root).locateLatestSession("/different/cwd")).toBeUndefined()
})

test("empty working dir returns undefined", () => {
  const root = tempDir()
  writeRollout(root, "00000000-0000-0000-0000-000000000001", "/some/where", 1781420400)
  expect(new CodexReader(root).locateLatestSession("")).toBeUndefined()
})

test("tolerates junk files", () => {
  const root = tempDir()
  const cwd = "/work/project"
  const dir = path.join(root, "2026", "06", "26")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "empty.jsonl"), "")
  writeFileSync(path.join(dir, "garbage.jsonl"), "{not json\n")
  writeFileSync(path.join(dir, "nometa.jsonl"), `{"type":"response_item","payload":{}}\n`)
  const want = "00000000-0000-0000-0000-0000000000aa"
  writeRollout(root, want, cwd, 1781420400)

  expect(new CodexReader(root).locateLatestSession(cwd)).toBe(want)
})

test("cleans paths (trailing slash)", () => {
  const root = tempDir()
  writeRollout(root, "00000000-0000-0000-0000-0000000000bb", "/work/project", 1781420400)
  expect(new CodexReader(root).locateLatestSession("/work/project/")).toBe(
    "00000000-0000-0000-0000-0000000000bb",
  )
})

test("matches through symlinked working dir", () => {
  const root = tempDir()
  const base = tempDir()
  const realDir = path.join(base, "real-cwd")
  mkdirSync(realDir, { recursive: true })
  const linkDir = path.join(base, "link-cwd")
  symlinkSync(realDir, linkDir)

  const recordedCwd = realpathSync(realDir)
  const want = "00000000-0000-0000-0000-0000000000cc"
  writeRollout(root, want, recordedCwd, 1781420400)

  expect(new CodexReader(root).locateLatestSession(linkDir)).toBe(want)
})
