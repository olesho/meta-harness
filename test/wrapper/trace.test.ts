import { expect, test } from "bun:test"
import {
  Discard,
  newLogAdapter,
  newWriterEmitter,
  type Event,
  type LogRecord,
  type Writer,
} from "../../src/wrapper/trace.ts"

class BufWriter implements Writer {
  data = ""
  write(chunk: string): void {
    this.data += chunk
  }
}

test("Discard drops events", () => {
  Discard.emit({ kind: "anything" })
})

test("writer emitter encodes a newline-framed JSON event", () => {
  const buf = new BufWriter()
  const emitter = newWriterEmitter(buf)
  const at = new Date(Date.UTC(2026, 4, 5, 12, 0, 0))
  emitter.emit({ at, kind: "pty_opened", fields: { pid: 1234, cols: 80 } })

  expect(buf.data.endsWith("\n")).toBe(true)
  const got = JSON.parse(buf.data) as { at: string; kind: string; fields: Record<string, number> }
  expect(got.kind).toBe("pty_opened")
  expect(new Date(got.at).getTime()).toBe(at.getTime())
  expect(got.fields.pid).toBe(1234)
})

test("writer emitter omits empty fields", () => {
  const buf = new BufWriter()
  newWriterEmitter(buf).emit({ kind: "wrapper_started" })
  expect(buf.data.includes("fields")).toBe(false)
})

test("writer emitter is ordered and lossless across many events", () => {
  const buf = new BufWriter()
  const emitter = newWriterEmitter(buf)
  const n = 500
  for (let i = 0; i < n; i++) emitter.emit({ kind: "test", fields: { i } })
  const lines = buf.data.trimEnd().split("\n")
  expect(lines.length).toBe(n)
  for (let i = 0; i < n; i++) {
    expect((JSON.parse(lines[i]) as { fields: { i: number } }).fields.i).toBe(i)
  }
})

test("log adapter preserves event time, kind, and fields", () => {
  const records: LogRecord[] = []
  const emitter = newLogAdapter({ handle: (r) => records.push(r) })
  const at = new Date(Date.UTC(2026, 4, 5, 12, 0, 0))
  const ev: Event = { at, kind: "harness_exited", fields: { exit_code: 0, signal: "" } }
  emitter.emit(ev)

  expect(records.length).toBe(1)
  const r = records[0]
  expect(r.message).toBe("harness_exited")
  expect(r.time.getTime()).toBe(at.getTime())
  expect(r.attrs.exit_code).toBe(0)
})
