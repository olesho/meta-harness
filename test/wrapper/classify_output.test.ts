import { describe, expect, test } from "vitest";
import {
  classifyOutput,
  StatusAPIError,
  StatusBlockedByCost,
  StatusRetryLater,
  StatusWaitingForInput,
} from "../../src/wrapper/index.ts";

// Transport failures classify as StatusRetryLater through the one-shot for both
// per-harness adapters and the generic default backing unknown harnesses.
describe("classifyOutput transport failures → retry_later", () => {
  const cases: { name: string; harness: string; output: string }[] = [
    {
      name: "claude/connection refused",
      harness: "claude",
      output: "Mock Agent CLI\nError: connection refused",
    },
    {
      name: "codex/ECONNREFUSED",
      harness: "codex",
      output: "request failed: connect ECONNREFUSED 127.0.0.1:443",
    },
    {
      name: "unknown/connection refused",
      harness: "",
      output: "node:internal/net: connection refused",
    },
    {
      name: "cursor/socket hang up",
      harness: "cursor",
      output: "Error: socket hang up",
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(classifyOutput(tc.harness, tc.output).status).toBe(
        StatusRetryLater,
      );
    });
  }
});

test("api error carries HTTP code", () => {
  const got = classifyOutput("claude", "API Error: 429 Too Many Requests");
  expect(got.status).toBe(StatusAPIError);
  expect(got.httpCode).toBe(429);
});

test("cost-specific reason surfaces matched phrase", () => {
  const got = classifyOutput("", "ERROR: quota exceeded. try later.");
  expect(got.status).toBe(StatusBlockedByCost);
  expect(got.reason).toContain("quota exceeded");
});

test("benign output is unclassified", () => {
  expect(classifyOutput("claude", "Step 1/3\nStep 2/3\nDONE").status).toBe("");
});

test("trailing prompt in a finished blob is not waiting_for_input", () => {
  const got = classifyOutput("claude", "Apply changes?\nContinue? (y/n)");
  expect(got.status).not.toBe(StatusWaitingForInput);
});
