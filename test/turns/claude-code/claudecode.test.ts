// Port of pkg/turns/harness/claudecode/claudecode_test.go.
// Corpus replay: bytes.raw → Screen → adapter, asserting marker fire/no-fire.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newScreen } from "../../../src/screen/index.ts"
import { encodedCWD } from "../../../src/transcript/claudecode/claudecode.ts"
import * as claudecode from "../../../src/turns/harness/claudecode.ts"
import { Errored, TurnComplete } from "../../../src/turns/index.ts"
import { corpusBytes } from "../corpus.ts"

const tmpRoots: string[] = []

describe("claude-code adapter", () => {
  test("fires TurnComplete on multi-turn recording", async () => {
    const bytes = corpusBytes("claude-code", "multi-turn")
    expect(bytes).not.toBeNull()
    const scr = newScreen(120, 40)
    await scr.write(bytes!)
    const evs = claudecode.New().onScreen(scr.snapshot())
    expect(evs.length).toBe(1)
    expect(evs[0]!.kind).toBe(TurnComplete)
  })

  test("detects interrupt", async () => {
    const bytes = corpusBytes("claude-code", "interrupted-mid-reply")
    expect(bytes).not.toBeNull()
    const scr = newScreen(120, 40)
    await scr.write(bytes!)
    const evs = claudecode.New().onScreen(scr.snapshot())
    expect(evs.some((e) => e.kind === Errored)).toBe(true)
  })

  test("refires across turns", async () => {
    const scr = newScreen(120, 40)
    const a = claudecode.New()

    await scr.write("⏺ first reply\r\n✻ Baked for 5s\r\n")
    expect(a.onScreen(scr.snapshot()).length).toBe(1)

    // Same fingerprint → no fire.
    expect(a.onScreen(scr.snapshot()).length).toBe(0)

    await scr.write("⏺ second reply\r\n✻ Brewed for 8s\r\n")
    expect(a.onScreen(scr.snapshot()).length).toBe(1)

    // Accented verb in the thinking summary.
    await scr.write("⏺ third reply\r\n✻ Sautéed for 4s\r\n")
    expect(a.onScreen(scr.snapshot()).length).toBe(1)
  })

  test("fires on minute/hour durations", async () => {
    const cases = [
      { name: "seconds", summary: "✻ Baked for 5s" },
      { name: "minutes", summary: "✻ Cooked for 1m 22s" },
      { name: "minutes-only", summary: "✻ Brewed for 2m" },
      { name: "hours", summary: "✻ Pondered for 1h 2m 3s" },
    ]
    for (const tc of cases) {
      const scr = newScreen(120, 40)
      const a = claudecode.New()
      await scr.write("⏺ reply\r\n" + tc.summary + "\r\n")
      const evs = a.onScreen(scr.snapshot())
      expect(evs.length).toBe(1)
      expect(evs[0]!.kind).toBe(TurnComplete)
    }
  })

  test("trailing content does not fire", async () => {
    const scr = newScreen(120, 40)
    const a = claudecode.New()
    await scr.write(
      "⏺ working\r\n✻ Cooked for 1m 22s · ↑ 3.1k tokens · esc to interrupt\r\n",
    )
    for (const ev of a.onScreen(scr.snapshot())) {
      expect(ev.kind).not.toBe(TurnComplete)
    }
  })

  test("name", () => {
    expect(claudecode.New().name()).toBe("claude-code")
  })

  test("adversarial thinking-line-mid-reply does not fire", async () => {
    const bytes = corpusBytes("claude-code", "adversarial/thinking-line-mid-reply")
    expect(bytes).not.toBeNull()
    const scr = newScreen(120, 40)
    await scr.write(bytes!)
    for (const ev of claudecode.New().onScreen(scr.snapshot())) {
      expect(ev.kind).not.toBe(TurnComplete)
    }
  })
})

describe("claude-code readTranscript", () => {
  afterEach(() => {
    for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
    tmpRoots.length = 0
  })

  test("projects the on-disk log to turns", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-projects-"))
    tmpRoots.push(root)

    const cwd = "/some/work/dir"
    const projDir = join(root, encodedCWD(cwd))
    mkdirSync(projDir, { recursive: true })
    const body =
      `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-05-14T12:00:00Z"}\n` +
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}]},"timestamp":"2026-05-14T12:00:05Z"}\n`
    writeFileSync(join(projDir, "sess-uuid.jsonl"), body)

    const a = claudecode.New()
    a.projectsRoot = root // test seam: override default ~/.claude/projects
    const turns = a.readTranscript("sess-uuid", cwd)
    expect(turns).toHaveLength(2)
    expect(turns[0]!.role).toBe("user")
    expect(turns[0]!.text).toBe("hello")
    expect(turns[1]!.role).toBe("assistant")
    expect(turns[1]!.text).toBe("hi there")
  })

  test("throws for a missing session", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-projects-"))
    tmpRoots.push(root)
    const a = claudecode.New()
    a.projectsRoot = root
    expect(() => a.readTranscript("missing", "/no/such/dir")).toThrow()
  })
})

describe("claude-code resumeArgs", () => {
  test("returns the --resume <uuid> flag", () => {
    const args = claudecode.New().resumeArgs("sess-uuid")
    expect(args).toEqual(["--resume", "sess-uuid"])
  })
})

describe("claude-code session control", () => {
  const uuidRE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  test("initSession mints --session-id <uuid>", () => {
    const [argv, id] = claudecode.New().initSession()
    expect(argv[0]).toBe("--session-id")
    expect(argv[1]).toBe(id)
    expect(id).toMatch(uuidRE)
  })

  test("initSession mints a fresh id per call", () => {
    const [, a] = claudecode.New().initSession()
    const [, b] = claudecode.New().initSession()
    expect(a).not.toBe(b)
  })

  test("sessionControlFlags lists the chat-managed flags", () => {
    expect(claudecode.New().sessionControlFlags()).toEqual([
      "--session-id",
      "-r",
      "--resume",
      "-c",
      "--continue",
      "--fork-session",
      "--from-pr",
      "--no-session-persistence",
    ])
  })

  test("extractSessionIDFromLine still matches the legacy resume hint", () => {
    const id = "74ca2184-c064-492c-88dc-c79c128de13e"
    const [got, ok] = claudecode
      .New()
      .extractSessionIDFromLine("  claude --resume " + id)
    expect(ok).toBe(true)
    expect(got).toBe(id)
    const [, miss] = claudecode.New().extractSessionIDFromLine("✻ Baked for 5s")
    expect(miss).toBe(false)
  })
})
