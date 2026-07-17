import { describe, it, expect } from "vitest"
import {
  StripANSI,
  Normalize,
  ExactMatch,
  Levenshtein,
  NormalizedDistance,
} from "./screenbench-metrics"

describe("StripANSI / Normalize", () => {
  it("Normalize strips SGR/CSI escape sequences", () => {
    const input = "\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[0m"
    expect(Normalize(input)).toBe("red green")
  })

  it("StripANSI (the wrapper re-export) removes ESC-led simple escapes", () => {
    // stripANSIEscapes strips the ESC and its final byte; it is the canonical
    // re-export, and Normalize layers full CSI stripping on top of it.
    expect(StripANSI("a\x1bcb")).toBe("ab")
    expect(typeof StripANSI).toBe("function")
  })

  it("strips per-line trailing whitespace", () => {
    expect(Normalize("foo   \nbar\t\nbaz")).toBe("foo\nbar\nbaz")
  })

  it("strips trailing blank lines at end of text", () => {
    expect(Normalize("a\nb\n\n\n")).toBe("a\nb")
    // Leading and interior blank lines are preserved.
    expect(Normalize("\na\n\nb\n\n")).toBe("\na\n\nb")
  })

  it("reconciles snapshot trailing whitespace with a zero-trailing oracle", () => {
    // Screen.snapshot().text keeps per-line trailing whitespace; the synth
    // expected.txt fixtures carry none. Normalize must make them equal.
    const snapshot = "line one    \nline two   \n"
    const oracle = "line one\nline two"
    expect(ExactMatch(snapshot, oracle)).toBe(false)
    expect(ExactMatch(Normalize(snapshot), Normalize(oracle))).toBe(true)
  })
})

describe("ExactMatch", () => {
  it("is strict equality of the (already-normalized) inputs", () => {
    expect(ExactMatch("abc", "abc")).toBe(true)
    expect(ExactMatch("abc", "abd")).toBe(false)
    expect(ExactMatch("", "")).toBe(true)
  })
})

describe("Levenshtein", () => {
  it("identical strings → 0", () => {
    expect(Levenshtein("kitten", "kitten")).toBe(0)
  })

  it("single substitution → 1", () => {
    expect(Levenshtein("cat", "bat")).toBe(1)
  })

  it("single insertion → 1", () => {
    expect(Levenshtein("cat", "cart")).toBe(1)
  })

  it("classic kitten/sitting → 3", () => {
    expect(Levenshtein("kitten", "sitting")).toBe(3)
  })

  it("empty vs non-empty → length of the other", () => {
    expect(Levenshtein("", "abc")).toBe(3)
    expect(Levenshtein("abc", "")).toBe(3)
    expect(Levenshtein("", "")).toBe(0)
  })

  it("counts in runes, not UTF-16 units", () => {
    // "🙂" is a single code point but two UTF-16 units.
    expect(Levenshtein("🙂", "🙃")).toBe(1)
  })
})

describe("NormalizedDistance", () => {
  it("identical → 0", () => {
    expect(NormalizedDistance("hello", "hello")).toBe(0)
  })

  it("empty vs empty → 0", () => {
    expect(NormalizedDistance("", "")).toBe(0)
  })

  it("single substitution normalized by max length", () => {
    expect(NormalizedDistance("cat", "bat")).toBeCloseTo(1 / 3, 10)
  })

  it("single insertion normalized by max length", () => {
    expect(NormalizedDistance("cat", "cart")).toBeCloseTo(1 / 4, 10)
  })

  it("disjoint strings → close to 1", () => {
    expect(NormalizedDistance("abc", "xyz")).toBe(1)
  })

  it("empty vs non-empty → 1", () => {
    expect(NormalizedDistance("", "abc")).toBe(1)
  })

  it("stays within [0,1]", () => {
    const d = NormalizedDistance("kitten", "sitting")
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBeLessThanOrEqual(1)
    expect(d).toBeCloseTo(3 / 7, 10)
  })
})
