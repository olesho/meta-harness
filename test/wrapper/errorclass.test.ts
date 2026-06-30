import { describe, expect, test } from "bun:test"
import {
  classifyOutput,
  errorClassString,
  ErrAuth,
  ErrBilling,
  ErrContextOverflow,
  ErrModelNotFound,
  ErrNone,
  ErrRateLimited,
  ErrTimeout,
  ErrTransient,
  ErrUnknown,
  StatusBlockedByCost,
  StatusRetryLater,
  type ErrorClass,
} from "../../src/wrapper/index.ts"

// The one-shot assigns the canonical ErrorClass for each harness-output shape.
describe("classifyOutput assigns ErrorClass", () => {
  const cases: { name: string; harness: string; output: string; want: ErrorClass }[] = [
    { name: "api 401 → auth", harness: "claude", output: "API Error: 401 Unauthorized", want: ErrAuth },
    { name: "api 402 → billing", harness: "claude", output: "API Error: 402 Payment Required", want: ErrBilling },
    { name: "api 404 → model-not-found", harness: "claude", output: "API Error: 404 model not found", want: ErrModelNotFound },
    { name: "api 429 → rate-limited", harness: "claude", output: "API Error: 429 Too Many Requests", want: ErrRateLimited },
    { name: "api 529 → transient", harness: "claude", output: "API Error: 529 Overloaded", want: ErrTransient },
    { name: "transport → transient", harness: "claude", output: "Mock\nError: connection refused", want: ErrTransient },
    { name: "usage limit → rate-limited", harness: "claude", output: "you've hit your usage limit", want: ErrRateLimited },
    { name: "quota exceeded → billing", harness: "claude", output: "Error: quota exceeded", want: ErrBilling },
    { name: "retry prose → transient", harness: "claude", output: "upstream error, please try again", want: ErrTransient },
    { name: "benign → none", harness: "claude", output: "Step 1/3\nDONE", want: ErrNone },
  ]
  for (const tc of cases) {
    test(tc.name, () => {
      const got = classifyOutput(tc.harness, tc.output)
      expect(got.class).toBe(tc.want)
    })
  }
})

// The registered cursor pack adds Retry-prose coverage the default would miss.
describe("classifyOutput cursor pack", () => {
  const cases: { name: string; output: string; status: string; class: ErrorClass }[] = [
    { name: "rate limit", output: "Error: rate limit exceeded", status: StatusBlockedByCost, class: ErrRateLimited },
    { name: "timeout prose", output: "the request timed out", status: StatusRetryLater, class: ErrTimeout },
    { name: "transient prose", output: "service unavailable, please try again", status: StatusRetryLater, class: ErrTransient },
  ]
  for (const tc of cases) {
    test(tc.name, () => {
      const got = classifyOutput("cursor", tc.output)
      expect(got.status).toBe(tc.status)
      expect(got.class).toBe(tc.class)
    })
  }
})

// Pin the canonical wire/display strings.
test("ErrorClass wire-compat strings", () => {
  const cases: [ErrorClass, string][] = [
    [ErrNone, "None"],
    [ErrRateLimited, "RateLimited"],
    [ErrAuth, "AuthFailure"],
    [ErrBilling, "BillingError"],
    [ErrModelNotFound, "ModelNotFound"],
    [ErrContextOverflow, "ContextOverflow"],
    [ErrTimeout, "Timeout"],
    [ErrTransient, "Transient"],
    [ErrUnknown, "Unknown"],
  ]
  for (const [c, want] of cases) {
    expect(errorClassString(c)).toBe(want)
  }
})
