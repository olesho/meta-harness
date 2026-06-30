import { describe, expect, test } from "bun:test"
import { newLineSplitter } from "../../src/wrapper/internal/linetap.ts"

const enc = (s: string) => new TextEncoder().encode(s)

function collect(flush: boolean, ...chunks: string[]): string[] {
  const got: string[] = []
  const ls = newLineSplitter((line) => got.push(line))
  for (const c of chunks) ls!.write(enc(c))
  if (flush) ls!.flush()
  return got
}

test("chunk boundaries reassemble in order", () => {
  expect(collect(false, "he", "llo\nwor", "ld\nthird\n")).toEqual([
    "hello",
    "world",
    "third",
  ])
})

test("CRLF trailing '\\r' trimmed", () => {
  expect(collect(false, "a\r\nb\r\nc\n")).toEqual(["a", "b", "c"])
})

test("empty lines preserved", () => {
  expect(collect(false, "a\n\nb\n")).toEqual(["a", "", "b"])
})

test("flush emits final unterminated line", () => {
  expect(collect(false, "done\ntail")).toEqual(["done"])
  expect(collect(true, "done\ntail")).toEqual(["done", "tail"])
  expect(collect(true, "x\ny\r")).toEqual(["x", "y"])
})

test("no trailing flush when clean", () => {
  expect(collect(true, "a\nb\n")).toEqual(["a", "b"])
})

test("multi-MB line reassembled whole (no cap)", () => {
  const total = 5 << 20
  const chunk = 7919
  const got: string[] = []
  const ls = newLineSplitter((line) => got.push(line))!
  let written = 0
  while (written < total) {
    const n = Math.min(chunk, total - written)
    ls.write(enc("x".repeat(n)))
    written += n
  }
  expect(got.length).toBe(0)
  ls.write(enc("\n"))
  expect(got.length).toBe(1)
  expect(got[0].length).toBe(total)
})

test("ordered, non-lossy under a working consumer", () => {
  const n = 1000
  const got: string[] = []
  let prev = -1
  const ls = newLineSplitter((line) => {
    const v = parseInt(line, 10)
    expect(v).toBe(prev + 1)
    prev = v
    got.push(line)
  })!
  let blob = ""
  for (let i = 0; i < n; i++) blob += i + "\n"
  ls.write(enc(blob.slice(0, blob.length / 2)))
  ls.write(enc(blob.slice(blob.length / 2)))
  expect(got.length).toBe(n)
})

test("nil splitter is a no-op", () => {
  const ls = newLineSplitter(null)
  expect(ls).toBeNull()
  ls?.write(enc("anything\n"))
  ls?.flush()
})
