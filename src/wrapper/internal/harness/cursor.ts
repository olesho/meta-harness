// Classifier patterns for the Cursor CLI harness. Cursor surfaces errors as
// free prose without an anchored "API Error: <code>" line, so this pack ships
// only the idle-gated Cost/Retry/Prompt fingerprints (no APIError matcher).

import { type Patterns as PatternSet } from "../detector/detector.ts"

/** Cursor harness fingerprint set. */
export const Patterns: PatternSet = {
  cost: [
    "rate limit",
    "rate-limit",
    "too many requests",
    "usage limit",
    "session limit",
    "quota exceeded",
    "limit resets",
    "resets at",
  ],
  retry: [
    "please try again",
    "temporary failure",
    "service unavailable",
    "internal server error",
    "overloaded",
    "timed out",
    "timeout",
    "etimedout",
    "econnreset",
  ],
  prompt: ["(y/n)", "(yes/no)", "[y/n]", "continue?", "proceed?"],
}
