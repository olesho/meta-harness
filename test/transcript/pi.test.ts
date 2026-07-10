import { afterEach, expect, test } from "vitest"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { isSentinel } from "../../src/internal/async/index.ts"
import { ErrEmptySessionID, ErrSessionNotFound } from "../../src/transcript/errors.ts"
import { PiReader, slugForCwd } from "../../src/transcript/pi/pi.ts"
import { tempDir } from "./tmp.ts"

const sessionUUID = "0281fd4a-0a10-4dfe-adca-9b61b3777255"

// writeSession lays down a pi-shaped session file under
// <root>/sessions/<dir>/<name> and returns the config root.
function writeSession(dir: string, name: string, body: string): string {
  const root = tempDir()
  const sessDir = path.join(root, "sessions", dir)
  mkdirSync(sessDir, { recursive: true })
  writeFileSync(path.join(sessDir, name), body)
  return root
}

const canonicalBody = `{"type":"session","version":3,"id":"${sessionUUID}","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/work/proj"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello pi"}}
{"type":"model_change","id":"mc000001","timestamp":"2024-12-03T14:00:01.500Z","model":"claude-sonnet-4-5"}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"},{"type":"text","text":"How can I help?"}],"provider":"anthropic","model":"claude-sonnet-4-5"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
{"type":"message","id":"d4e5f6a7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:00:04.000Z","message":{"role":"assistant","content":[{"type":"image","source":"…"}]}}
`

const savedEnv = process.env.PI_CODING_AGENT_DIR
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = savedEnv
})

test("read canonical session", () => {
  const root = writeSession(
    slugForCwd("/work/proj"),
    "20241203T140000_" + sessionUUID + ".jsonl",
    canonicalBody,
  )
  const turns = new PiReader(root).read(sessionUUID, "/work/proj")
  expect(turns).toHaveLength(3)
  expect(turns[0]!.role).toBe("user")
  expect(turns[0]!.text).toBe("Hello pi")
  expect(turns[1]!.role).toBe("assistant")
  expect(turns[1]!.text).toBe("Hi!\n\nHow can I help?")
  expect(turns[2]!.role).toBe("system")
  expect(turns[2]!.text).toBe("output")
  expect(turns[0]!.timestamp).toBeDefined()
})

test("walk fallback without working dir", () => {
  const root = writeSession(
    "--some-other-slug--",
    "20241203T140000_" + sessionUUID + ".jsonl",
    canonicalBody,
  )
  const turns = new PiReader(root).read(sessionUUID, "")
  expect(turns).toHaveLength(3)
})

test("header mismatch is not returned", () => {
  const body = `{"type":"session","version":3,"id":"some-other-id","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/work/proj"}
{"type":"message","id":"x","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"nope"}}
`
  const root = writeSession(
    slugForCwd("/work/proj"),
    "20241203T140000_" + sessionUUID + ".jsonl",
    body,
  )
  expect(() => new PiReader(root).read(sessionUUID, "/work/proj")).toThrow()
})

test("empty session id errors with sentinel", () => {
  let caught: unknown
  try {
    new PiReader(tempDir()).read("", "/work/proj")
  } catch (err) {
    caught = err
  }
  expect(caught).toBeDefined()
  expect(isSentinel(caught, ErrEmptySessionID)).toBe(true)
})

test("PI_CODING_AGENT_DIR env override", () => {
  const root = writeSession(
    slugForCwd("/work/proj"),
    "20241203T140000_" + sessionUUID + ".jsonl",
    canonicalBody,
  )
  process.env.PI_CODING_AGENT_DIR = root
  const turns = new PiReader().read(sessionUUID, "/work/proj")
  expect(turns).toHaveLength(3)
})

test("missing sessions dir throws ErrSessionNotFound sentinel", () => {
  const root = path.join(tempDir(), "no-such-config")
  let caught: unknown
  try {
    new PiReader(root).read(sessionUUID, "/work/proj")
  } catch (err) {
    caught = err
  }
  expect(caught).toBeDefined()
  expect(isSentinel(caught, ErrSessionNotFound)).toBe(true)
})

test("direct sessionsDir input resolves the session", () => {
  const root = writeSession(
    slugForCwd("/work/proj"),
    "20241203T140000_" + sessionUUID + ".jsonl",
    canonicalBody,
  )
  const sessionsDir = path.join(root, "sessions")
  const turns = new PiReader({ sessionsDir }).read(sessionUUID, "/work/proj")
  expect(turns).toHaveLength(3)
})

test("constructor back-compat: string root and {root} resolve identically", () => {
  const root = writeSession(
    slugForCwd("/work/proj"),
    "20241203T140000_" + sessionUUID + ".jsonl",
    canonicalBody,
  )
  const a = new PiReader(root).read(sessionUUID, "/work/proj")
  const b = new PiReader({ root }).read(sessionUUID, "/work/proj")
  expect(a).toEqual(b)
  expect(a).toHaveLength(3)
})

test("slugForCwd cases", () => {
  const cases: Record<string, string> = {
    "/home/user/myproject": "--home-user-myproject--",
    "/work/proj": "--work-proj--",
    "/work/proj/": "--work-proj--",
  }
  for (const [input, want] of Object.entries(cases)) {
    expect(slugForCwd(input)).toBe(want)
  }
})
