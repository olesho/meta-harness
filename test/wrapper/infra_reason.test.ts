// Lock the infra-failure reason wording. The orchestrator's INFRA_CAUSE_PATTERNS classify a
// harness failure as INFRASTRUCTURE (so it bypasses the runaway guard) by
// matching tokens in the reason string — /pty/i, /not found/i, /enoent/i,
// /spawn .* failed/i. These assertions freeze the meta-harness wording so a
// refactor can't silently break that classification on the orchestrator side.

import { describe, expect, test } from "vitest"
import {
  ErrBinaryNotFound,
  ErrPTYAllocation,
  run,
} from "../../src/wrapper/index.ts"
import { newScreen } from "../../src/screen/index.ts"

describe("infra-failure reasons match the orchestrator INFRA_CAUSE_PATTERNS", () => {
  test("ErrBinaryNotFound message contains 'not found'", () => {
    expect(ErrBinaryNotFound.message.toLowerCase()).toContain("not found")
  })

  test("ErrPTYAllocation message contains 'pty'", () => {
    expect(ErrPTYAllocation.message.toLowerCase()).toContain("pty")
  })

  test("run() with a missing binary surfaces a reason containing 'not found'", async () => {
    const { result, err } = await run(undefined, {
      binaryPath: "/nonexistent/definitely-not-a-real-harness-xyz",
      stdout: newScreen(80, 24),
      harness: "generic",
    })
    expect(err).not.toBeNull()
    expect(result.reason.toLowerCase()).toContain("not found")
  })
})
