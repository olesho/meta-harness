import { describe, expect, test } from "vitest"
import {
  EventText,
  EventToolResult,
  EventToolUse,
  RoleAssistant,
  RoleUser,
  SourceFile,
  SourceLive,
  eventID,
  envelope,
  turnsFromEvents,
  type Event,
  type ParsedEvent,
} from "../../src/transcript/event.ts"

describe("eventID", () => {
  test("parser-owned nativeID wins", () => {
    const e: Event = {
      nativeID: "tool-result:abc",
      uuid: "u",
      toolUseID: "abc",
      type: EventToolResult,
    }
    expect(eventID(e)).toBe("tool-result:abc")
  })

  test("kind-qualified distinctness for tool-use vs tool-result", () => {
    const use: Event = { type: EventToolUse, toolUseID: "t1" }
    const res: Event = { type: EventToolResult, toolUseID: "t1" }
    expect(eventID(use)).not.toBe(eventID(res))
  })

  test("stable across seq and arrival source", () => {
    const ts = new Date(Date.UTC(2026, 4, 14, 12, 0, 0))
    const live: Event = {
      seq: 3,
      role: RoleAssistant,
      type: EventText,
      text: "hello",
      timestamp: ts,
      source: SourceLive,
    }
    const file: Event = {
      seq: 99,
      role: RoleAssistant,
      type: EventText,
      text: "hello",
      timestamp: ts,
      source: SourceFile,
    }
    expect(eventID(live)).toBe(eventID(file))
  })

  test("message uuid prefixed", () => {
    const e: Event = { uuid: "uuid-1", role: RoleUser, type: EventText }
    expect(eventID(e)).toBe("msg:uuid-1")
  })
})

test("envelope routing fields", () => {
  const pe: ParsedEvent = {
    harnessSessionID: "s1",
    parentSessionID: "p1",
    event: { text: "x" },
  }
  const env = envelope(pe, "run-7", "claude")
  expect(env.runID).toBe("run-7")
  expect(env.harness).toBe("claude")
  expect(env.harnessSessionID).toBe("s1")
  expect(env.parentSessionID).toBe("p1")
  expect(env.event.text).toBe("x")
})

test("turnsFromEvents drops tool-only events", () => {
  const ts = new Date()
  const events: Event[] = [
    { role: RoleUser, type: EventText, text: "hi", timestamp: ts },
    { role: RoleAssistant, type: EventToolUse, toolName: "Bash", toolUseID: "t1" },
    { role: RoleAssistant, type: EventText, text: "done", timestamp: ts },
  ]
  const turns = turnsFromEvents(events)
  expect(turns).toHaveLength(2)
  expect(turns[0]!.role).toBe(RoleUser)
  expect(turns[0]!.text).toBe("hi")
  expect(turns[1]!.text).toBe("done")
})
