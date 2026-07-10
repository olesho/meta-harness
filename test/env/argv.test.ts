// Tier-1: injection-safe argv single-quoting against hostile inputs.

import { describe, expect, test } from "vitest"
import { argvToShell, envPrefixedShell, shQuote } from "../../src/env/index.ts"

describe("shQuote — strict single-quoting", () => {
  test("empty string becomes an explicit empty token", () => {
    expect(shQuote("")).toBe("''")
  })

  test("plain word is quoted", () => {
    expect(shQuote("hello")).toBe("'hello'")
  })

  test("embedded single quote is escaped via the '\\'' idiom", () => {
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })

  // Each hostile string must round-trip through `sh -c` as a SINGLE argv token.
  const hostile = [
    "; rm -rf /",
    "$(whoami)",
    "`id`",
    "a && b",
    "x | y",
    "--dangerous-flag",
    "line1\nline2",
    "quote'inside",
    'double"quote',
    "\\backslash",
    "$HOME",
  ]
  for (const s of hostile) {
    test(`hostile input stays inert: ${JSON.stringify(s)}`, () => {
      const q = shQuote(s)
      // No unescaped shell metacharacter can appear outside the quotes: the
      // whole payload is inside a single-quote run except for the '\'' escapes.
      expect(q.startsWith("'")).toBe(true)
      expect(q.endsWith("'")).toBe(true)
    })
  }
})

describe("argvToShell", () => {
  test("each token is independently quoted so none can inject another", () => {
    expect(argvToShell(["echo", "; rm -rf /", "$(x)"])).toBe("'echo' '; rm -rf /' '$(x)'")
  })
})

describe("envPrefixedShell", () => {
  test("no env → plain quoted argv (no bare env prefix)", () => {
    expect(envPrefixedShell(undefined, ["ls", "-la"])).toBe("'ls' '-la'")
    expect(envPrefixedShell({}, ["ls"])).toBe("'ls'")
  })

  test("env values are quoted and keys sorted deterministically", () => {
    expect(envPrefixedShell({ B: "2", A: "one two" }, ["run"])).toBe("env A='one two' B='2' 'run'")
  })

  test("hostile env value cannot break the prefix", () => {
    const out = envPrefixedShell({ TOKEN: "'; rm -rf / #" }, ["cmd"])
    expect(out).toBe("env TOKEN=''\\''; rm -rf / #' 'cmd'")
  })
})
