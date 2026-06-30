// Classifier patterns for the pi coding agent (@earendil-works/pi-coding-agent,
// binary "pi").
//
// pi is provider-agnostic, so the error text varies by provider. There is no
// single anchored API-error format to key on, so apiError is left null and the
// Cost/Retry string lists carry conservative cross-provider hints.

import { type Patterns as PatternSet } from "../detector/detector.ts"

/** pi harness fingerprint set. */
export const Patterns: PatternSet = {
  cost: [
    "rate limit",
    "rate-limit",
    "rate limit exceeded",
    "quota exceeded",
    "insufficient_quota",
    "insufficient quota",
    "usage limit",
    "you have exceeded",
    "credit balance is too low",
    "billing",
    "resource_exhausted",
    "resource has been exhausted",
  ],
  retry: [
    "please try again",
    "try again later",
    "overloaded",
    "transient error",
    "temporary failure",
    "network error",
    "connection error",
    "upstream error",
    "deadline exceeded",
    "service unavailable",
    "unavailable",
  ],
  prompt: [
    "(y/n)",
    "(y/n/a)",
    "(yes/no)",
    "continue?",
    "allow?",
    "do you want to continue?",
    "do you want to proceed?",
    "approve?",
  ],
}
