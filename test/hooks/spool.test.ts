import { afterEach, describe, expect, test } from "vitest"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  EventSessionMeta,
  EventText,
  RoleAssistant,
  RoleSystem,
  SourceFile,
  SourceHook,
  type ParsedEvent,
} from "../../src/transcript/event.ts"
import {
  appendSpool,
  drainSpool,
  spoolFileName,
  spoolFilePath,
} from "../../src/hooks/spool.ts"

const dirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mh-spool-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function pe(over: Partial<ParsedEvent> & { text?: string } = {}): ParsedEvent {
  return {
    harnessSessionID: over.harnessSessionID ?? "sid-1",
    parentSessionID: over.parentSessionID,
    event: over.event ?? {
      role: RoleSystem,
      type: EventSessionMeta,
      text: over.text ?? "session-start:startup",
      source: SourceHook,
      nativeID: "hook:session_meta:sid-1:startup",
    },
  }
}

describe("spool round-trip", () => {
  test("drainSpool returns canonical ParsedEvents with Event.source === SourceHook", () => {
    const dir = freshDir()
    appendSpool(dir, [pe({ text: "a" }), pe({ text: "b" })])

    const drained = drainSpool(dir)
    expect(drained).toHaveLength(2)
    for (const d of drained) {
      // Assert on the Event/ParsedEvent value — the layer that carries source.
      expect(d.event.source).toBe(SourceHook)
    }
    expect(drained[0].event.text).toBe("a")
    expect(drained[1].event.text).toBe("b")
    expect(drained[0].harnessSessionID).toBe("sid-1")
  })

  test("drainSpool truncates the spool — a second drain returns nothing", () => {
    const dir = freshDir()
    appendSpool(dir, [pe({ text: "one" })])
    expect(drainSpool(dir)).toHaveLength(1)
    // Spool file still exists but is empty.
    expect(existsSync(spoolFilePath(dir))).toBe(true)
    expect(readFileSync(spoolFilePath(dir), "utf8")).toBe("")
    expect(drainSpool(dir)).toHaveLength(0)
  })

  test("preserves arrival order across multiple appends within a drain", () => {
    const dir = freshDir()
    appendSpool(dir, [pe({ text: "1" }), pe({ text: "2" })])
    appendSpool(dir, [pe({ text: "3" })])
    appendSpool(dir, [pe({ text: "4" }), pe({ text: "5" })])

    const drained = drainSpool(dir)
    expect(drained.map((d) => d.event.text)).toEqual(["1", "2", "3", "4", "5"])
  })

  test("re-stamps SourceHook even if a record arrived with another source", () => {
    const dir = freshDir()
    const spoofed = pe()
    spoofed.event = { ...spoofed.event, source: SourceFile }
    appendSpool(dir, [spoofed])

    const [d] = drainSpool(dir)
    expect(d.event.source).toBe(SourceHook)
  })

  test("round-trips a Date timestamp back to a Date", () => {
    const dir = freshDir()
    const ts = new Date("2026-07-17T12:34:56.000Z")
    appendSpool(dir, [
      {
        harnessSessionID: "sid-9",
        event: {
          role: RoleAssistant,
          type: EventText,
          text: "hi",
          timestamp: ts,
          source: SourceHook,
        },
      },
    ])
    const [d] = drainSpool(dir)
    expect(d.event.timestamp).toBeInstanceOf(Date)
    expect(d.event.timestamp?.getTime()).toBe(ts.getTime())
  })

  test("preserves parentSessionID when set and omits it otherwise", () => {
    const dir = freshDir()
    appendSpool(dir, [
      pe({ text: "child", parentSessionID: "parent-1" }),
      pe({ text: "top" }),
    ])
    const drained = drainSpool(dir)
    expect(drained[0].parentSessionID).toBe("parent-1")
    expect(drained[1].parentSessionID).toBeUndefined()
  })

  test("empty batch is a no-op; missing spool drains to []", () => {
    const dir = freshDir()
    appendSpool(dir, [])
    expect(existsSync(spoolFilePath(dir))).toBe(false)
    expect(drainSpool(dir)).toEqual([])
  })

  test("skips blank and corrupt lines without aborting the drain", () => {
    const dir = freshDir()
    appendSpool(dir, [pe({ text: "good" })])
    // Corrupt the spool by appending garbage lines directly.
    const file = spoolFilePath(dir)
    appendFileSync(file, "\n{ not json }\n\n")
    appendSpool(dir, [pe({ text: "also-good" })])

    const drained = drainSpool(dir)
    expect(drained.map((d) => d.event.text)).toEqual(["good", "also-good"])
  })

  test("spoolFilePath composes the fixed basename onto the dir", () => {
    expect(spoolFilePath("/x/y")).toBe(path.join("/x/y", spoolFileName))
  })
})
