import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { GeminiReader, sessionShort } from "../../src/transcript/gemini/gemini.ts"
import { tempDir } from "./tmp.ts"

const testSessionID = "0281fd4a-0a10-4dfe-adca-9b61b3777255"
const testShort = "0281fd4a"

function writeProjectsJSON(root: string, workingDir: string, slug: string): void {
  const body = JSON.stringify({ projects: { [workingDir]: slug } })
  writeFileSync(path.join(root, "projects.json"), body)
}

function writeSessionFile(
  root: string,
  slug: string,
  filename: string,
  body: string,
): void {
  const dir = path.join(root, "tmp", slug, "chats")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, filename), body)
}

// Shape A: {"role":"user","parts":[{"text":"..."}]}
test("parses API shape", () => {
  const root = tempDir()
  const cwd = "/Users/me/Work/aether"
  writeProjectsJSON(root, cwd, "aether")
  const body = `{"sessionId":"${testSessionID}","projectHash":"abc","startTime":"2026-05-14T10:00:00Z","kind":"main"}
{"role":"user","parts":[{"text":"hello"}],"timestamp":"2026-05-14T10:00:01Z"}
{"role":"model","parts":[{"text":"hi"},{"text":"there"}],"timestamp":"2026-05-14T10:00:02Z"}
`
  writeSessionFile(root, "aether", "session-2026-05-14T10-00-" + testShort + ".jsonl", body)

  const turns = new GeminiReader(root).read(testSessionID, cwd)
  expect(turns).toHaveLength(2)
  expect(turns[0]!.role).toBe("user")
  expect(turns[0]!.text).toBe("hello")
  expect(turns[1]!.role).toBe("assistant")
  expect(turns[1]!.text).toBe("hi\n\nthere")
})

// Shape B: {"type":"user","message":"..."}
test("parses type/message shape", () => {
  const root = tempDir()
  const cwd = "/Users/me/Work/aether"
  writeProjectsJSON(root, cwd, "aether")
  const body = `{"sessionId":"${testSessionID}","kind":"main"}
{"type":"user","message":"prompt","timestamp":"2026-05-14T10:00:01Z"}
{"type":"assistant","message":"answer","timestamp":"2026-05-14T10:00:02Z"}
`
  writeSessionFile(root, "aether", "session-2026-05-14T10-00-" + testShort + ".jsonl", body)

  const turns = new GeminiReader(root).read(testSessionID, cwd)
  expect(turns).toHaveLength(2)
  expect(turns[0]!.text).toBe("prompt")
  expect(turns[1]!.text).toBe("answer")
})

test("walk fallback", () => {
  const root = tempDir()
  const cwd = "/Users/me/Work/unmapped"
  const body = `{"sessionId":"${testSessionID}","kind":"main"}
{"role":"user","parts":[{"text":"hi"}]}
`
  writeSessionFile(root, "some-other-slug", "session-2026-05-14T10-00-" + testShort + ".jsonl", body)

  const turns = new GeminiReader(root).read(testSessionID, cwd)
  expect(turns).toHaveLength(1)
  expect(turns[0]!.text).toBe("hi")
})

test("disambiguates by header", () => {
  const root = tempDir()
  const cwd = "/Users/me/Work/aether"
  writeProjectsJSON(root, cwd, "aether")
  const wantID = "0281fd4a-0000-0000-0000-000000000001"
  const otherID = "0281fd4a-0000-0000-0000-000000000002"

  writeSessionFile(
    root,
    "aether",
    "session-2026-05-14T10-00-" + testShort + ".jsonl",
    `{"sessionId":"${otherID}","kind":"main"}
{"role":"user","parts":[{"text":"wrong"}]}
`,
  )
  writeSessionFile(
    root,
    "aether",
    "session-2026-05-14T11-00-" + testShort + ".jsonl",
    `{"sessionId":"${wantID}","kind":"main"}
{"role":"user","parts":[{"text":"right"}]}
`,
  )

  const turns = new GeminiReader(root).read(wantID, cwd)
  expect(turns).toHaveLength(1)
  expect(turns[0]!.text).toBe("right")
})

test("empty session id errors", () => {
  expect(() => new GeminiReader().read("", "/some/dir")).toThrow()
})

test("missing file errors", () => {
  expect(() => new GeminiReader(tempDir()).read(testSessionID, "/no/such/dir")).toThrow()
})

test("sessionShort cases", () => {
  const cases: Record<string, string> = {
    "0281fd4a-0a10-4dfe-adca-9b61b3777255": "0281fd4a",
    abcd1234: "abcd1234",
    abc: "abc",
    "": "",
  }
  for (const [input, want] of Object.entries(cases)) {
    expect(sessionShort(input)).toBe(want)
  }
})
