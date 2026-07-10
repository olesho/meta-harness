import { expect, test } from "vitest"
import {
  EventToolResult,
  EventToolUse,
  RoleUser,
  SourceFile,
  eventID,
} from "../../../src/transcript/event.ts"
import { events } from "../../../src/transcript/codex/parseCodex.ts"

test("events tool-aware", () => {
  const body = `{"timestamp":"2026-05-14T12:00:00Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do it <ide_selection>noise</ide_selection>"}]}}
{"timestamp":"2026-05-14T12:00:01Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"sure"},{"type":"output_text","text":"running"}]}}
{"timestamp":"2026-05-14T12:00:02Z","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"call_1","arguments":"{\\"cmd\\":\\"ls\\"}"}}
{"timestamp":"2026-05-14T12:00:03Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"file.go"}}
{"type":"event_msg","payload":{"x":1}}
`
  const evs = events(body)
  expect(evs).toHaveLength(5)
  expect(evs[0]!.role).toBe(RoleUser)
  expect(evs[0]!.text).toBe("do it")
  expect(evs[1]!.text).toBe("sure")
  expect(evs[2]!.text).toBe("running")

  const tu = evs[3]!
  expect(tu.type).toBe(EventToolUse)
  expect(tu.toolName).toBe("shell")
  expect(tu.toolUseID).toBe("call_1")
  expect(tu.toolInput).toBe(`{"cmd":"ls"}`)
  expect(eventID(tu)).toBe("tool-use:call_1")

  const tr = evs[4]!
  expect(tr.type).toBe(EventToolResult)
  expect(tr.toolUseID).toBe("call_1")
  expect(tr.output).toBe("file.go")
  expect(eventID(tr)).toBe("tool-result:call_1")

  for (const e of evs) expect(e.source).toBe(SourceFile)
})

test("events skips noise and empty", () => {
  const body = `{"type":"session_meta","payload":{"id":"x"}}
{"type":"response_item","payload":{"type":"reasoning","summary":"thinking"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}
`
  expect(events(body)).toHaveLength(0)
})
