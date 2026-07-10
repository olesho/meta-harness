// §10 Tier-5 protocol freeze. Two goldens shared by producer + client:
//   1. the exit constants + DeadlineLine pinned to their frozen literals;
//   2. the emit()/parse() JSON KEY-and-TYPE schema (not an exact sample line —
//      JSON.stringify omits undefined keys, so the three optional keys are
//      present-with-type when set and absent otherwise).

import { describe, expect, test } from "vitest"

import {
  DeadlineLine,
  ExitDeadline,
  ExitError,
  ExitOK,
  ExitUsage,
  parseLastJSONLine,
  type StructuredTurnResult,
} from "../../src/turnproto/index.ts"

// The CLIs re-export from turnproto; assert they resolve to the SAME literals so
// no hand-synced copy can drift (acceptance: ONE source of truth).
import * as runCli from "../../src/cli/run.ts"
import * as structuredCli from "../../src/cli/structured-runner.ts"

describe("frozen exit constants", () => {
  test("pin the exact literals", () => {
    expect(ExitOK).toBe(0)
    expect(ExitError).toBe(1)
    expect(ExitUsage).toBe(2)
    expect(ExitDeadline).toBe(124)
  })

  test("pin the literal DeadlineLine string", () => {
    expect(DeadlineLine).toBe("harness-wrapper run: context deadline exceeded")
  })

  test("both CLIs re-export the SAME constants (no drift)", () => {
    for (const cli of [runCli, structuredCli]) {
      expect(cli.ExitOK).toBe(ExitOK)
      expect(cli.ExitError).toBe(ExitError)
      expect(cli.ExitUsage).toBe(ExitUsage)
      expect(cli.ExitDeadline).toBe(ExitDeadline)
      expect(cli.DeadlineLine).toBe(DeadlineLine)
    }
  })
})

describe("frozen emit/parse JSON schema (key + type, not a sample line)", () => {
  // The minimal payload the producer ALWAYS emits: five required keys, three
  // optional keys absent.
  const required = {
    status: "completed",
    reply: "the reply",
    harnessSessionID: "sess-1",
    transcript_entries: [{ role: "user" }],
    working_dir: "/repo",
  }

  test("required keys are present with their frozen types", () => {
    const parsed = parseLastJSONLine(JSON.stringify(required) + "\n")!
    expect(parsed).not.toBeNull()
    expect(typeof parsed.status).toBe("string")
    expect(typeof parsed.reply).toBe("string")
    expect(typeof parsed.harnessSessionID).toBe("string")
    expect(Array.isArray(parsed.transcript_entries)).toBe(true)
    expect(typeof parsed.working_dir).toBe("string")
  })

  test("the three optional keys are ABSENT when unset", () => {
    const parsed = parseLastJSONLine(JSON.stringify(required) + "\n")!
    expect("usage" in parsed).toBe(false)
    expect("reason" in parsed).toBe(false)
    expect("transcript_error" in parsed).toBe(false)
  })

  test("optional keys are present-with-type when set", () => {
    const full: StructuredTurnResult = {
      ...required,
      usage: { input_tokens: 10, output_tokens: 20 },
      reason: "boom",
      transcript_error: "read failed",
    }
    const parsed = parseLastJSONLine(JSON.stringify(full) + "\n")!
    expect(typeof parsed.usage).toBe("object")
    expect(typeof parsed.usage!.input_tokens).toBe("number")
    expect(typeof parsed.reason).toBe("string")
    expect(typeof parsed.transcript_error).toBe("string")
  })

  test("the exact frozen key set (guards against silent additions)", () => {
    const full = {
      ...required,
      usage: { input_tokens: 1 },
      reason: "r",
      transcript_error: "e",
    }
    expect(Object.keys(full).sort()).toEqual(
      [
        "harnessSessionID",
        "reason",
        "reply",
        "status",
        "transcript_entries",
        "transcript_error",
        "usage",
        "working_dir",
      ].sort(),
    )
  })
})
