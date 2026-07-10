import { describe, expect, test } from "vitest"
import { HarnessAdapter } from "../../src/wrapper/internal/harnessAdapter.ts"
import { Patterns as claudePatterns } from "../../src/wrapper/internal/harness/claude.ts"
import { Patterns as codexPatterns } from "../../src/wrapper/internal/harness/codex.ts"
import type { ClassifierInput } from "../../src/wrapper/internal/classification.ts"
import {
  StatusAPIError,
  StatusBlockedByCost,
  StatusRetryLater,
  StatusWaitingForInput,
} from "../../src/wrapper/internal/status.ts"

const claude = new HarnessAdapter(claudePatterns)
const codex = new HarnessAdapter(codexPatterns)

interface Case {
  name: string
  adapter: HarnessAdapter
  input: ClassifierInput
  wantStatus: string
  wantCode?: number
  wantRetry?: number
  reasonHas?: string
  wantResumeAtOK?: boolean
}

const cases: Case[] = [
  { name: "A1: claude api_error 529 without idle gate", adapter: claude, input: { recentOutput: "API Error: 529 Overloaded." }, wantStatus: StatusAPIError, wantCode: 529 },
  { name: "A2: claude api_error 429 carries RetryAfter", adapter: claude, input: { recentOutput: "API Error: 429 Too Many Requests. Retry after 30 seconds." }, wantStatus: StatusAPIError, wantCode: 429, wantRetry: 30_000 },
  { name: "A2b: claude transport-error variant with tree-character prefix", adapter: claude, input: { recentOutput: "  ⎿  API Error: The socket connection was closed unexpectedly." }, wantStatus: StatusAPIError, wantCode: 0, reasonHas: "socket connection was closed" },
  { name: "A4: codex exceeded retry limit with explicit 503", adapter: codex, input: { recentOutput: "■ exceeded retry limit, last status: 503" }, wantStatus: StatusAPIError, wantCode: 503 },
  { name: "A5: cost path on idle", adapter: claude, input: { recentOutput: "you've hit your limit", idle: true }, wantStatus: StatusBlockedByCost },
  { name: "A6: retry path on idle", adapter: claude, input: { recentOutput: "please try again", idle: true }, wantStatus: StatusRetryLater },
  { name: "A7: prompt detection on quiet trailing line", adapter: claude, input: { recentOutput: "Some text\nContinue? [y/N]", quiet: true }, wantStatus: StatusWaitingForInput },
  { name: "A8: api_error wins over cost when both present", adapter: claude, input: { recentOutput: "you've hit your limit\nAPI Error: 529 Overloaded.", idle: true }, wantStatus: StatusAPIError, wantCode: 529 },
  { name: "A9: false-positive guard — mid-line API Error in prose", adapter: claude, input: { recentOutput: "chitchat about API Error: 500 mid-line", idle: true }, wantStatus: "" },
  { name: "A11: claude session-limit banner without idle gate", adapter: claude, input: { recentOutput: "  ⎿  You've hit your session limit · resets 6:40pm (Europe/Warsaw)\n     /usage-credits to finish what you're working on." }, wantStatus: StatusBlockedByCost, reasonHas: "session limit", wantResumeAtOK: true },
]

describe("HarnessAdapter.classify", () => {
  for (const tc of cases) {
    test(tc.name, () => {
      const got = tc.adapter.classify(tc.input)
      expect(got.status).toBe(tc.wantStatus)
      if (tc.wantStatus === "") return
      expect(got.httpCode).toBe(tc.wantCode ?? 0)
      expect(got.retryAfter).toBe(tc.wantRetry ?? 0)
      const wantTerminal =
        tc.wantStatus === StatusBlockedByCost || tc.wantStatus === StatusRetryLater
      expect(got.terminal).toBe(wantTerminal)
      if (tc.reasonHas) expect(got.reason).toContain(tc.reasonHas)
      if (tc.wantResumeAtOK) {
        expect(got.resumeAt).not.toBeNull()
        expect(got.resumeAt!.getTime()).toBeGreaterThan(Date.now())
      }
    })
  }
})
