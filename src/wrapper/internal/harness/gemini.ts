// Classifier patterns for Google's Gemini CLI (@google/gemini-cli).

import {
  parseRetryAfter,
  type APIErrorHit,
  type Patterns as PatternSet,
} from "../detector/detector.ts"

// apiErrorRE matches Gemini CLI's square-bracket-wrapped format.
// Group 1 → message, group 2 (optional) → 3-digit status code.
const apiErrorRE = /\[API Error:\s*(.*?)(?:\s*\(Status:\s*(\d{3})\))?\]/

/** MatchAPIError implements an APIErrorMatcher for Gemini CLI. */
export function matchAPIError(stripped: string): APIErrorHit | null {
  const m = apiErrorRE.exec(stripped)
  if (!m) return null
  const message = (m[1] ?? "").trim()
  const hit: APIErrorHit = { code: 0, message, retryAfter: 0 }
  if (m[2]) {
    hit.code = parseInt(m[2], 10)
  } else if (message.toLowerCase().includes("please wait and try again later")) {
    hit.code = 429
  }
  hit.retryAfter = parseRetryAfter(message)
  return hit
}

/** Gemini harness fingerprint set. */
export const Patterns: PatternSet = {
  apiError: matchAPIError,
  cost: [
    "quota exceeded",
    "resource has been exhausted",
    "resource_exhausted",
    "rate limit",
    "rate-limit",
    "rate limit exceeded",
    "usage limit",
    "you have exceeded",
    "free tier",
  ],
  retry: [
    "please try again",
    "transient error",
    "temporary failure",
    "network error",
    "upstream error",
    "deadline exceeded",
    "unavailable",
  ],
  prompt: [
    "(y/n)",
    "(y/n/a)",
    "(yes/no)",
    "continue?",
    "apply this change?",
    "do you want to continue?",
    "allow?",
  ],
}
