// Classifier patterns for the OpenAI Codex CLI harness.

import {
  parseRetryAfter,
  type APIErrorHit,
  type Patterns as PatternSet,
} from "../detector/detector.ts";

// retryLimitRE captures "exceeded retry limit, last status: NNN".
const retryLimitRE = /exceeded retry limit,\s*last status:\s*(\d{3})/i;

// codexPhraseHits maps known Codex error-display phrases to inferred HTTP codes.
const codexPhraseHits: { phrase: string; code: number }[] = [
  { phrase: "selected model is at capacity", code: 503 },
  { phrase: "currently experiencing high demand", code: 500 },
  { phrase: "usage limit reached", code: 429 },
  { phrase: "you're out of credits", code: 429 },
  { phrase: "quota exceeded", code: 429 },
  { phrase: "stream disconnected before completion", code: 0 },
];

/** MatchAPIError implements an APIErrorMatcher for Codex CLI. */
export function matchAPIError(stripped: string): APIErrorHit | null {
  const lower = stripped.toLowerCase();

  const m = retryLimitRE.exec(stripped);
  if (m) {
    return {
      code: parseInt(m[1], 10),
      message: "exceeded retry limit, last status: " + m[1],
      retryAfter: parseRetryAfter(stripped),
    };
  }

  for (const p of codexPhraseHits) {
    const idx = lower.indexOf(p.phrase);
    if (idx >= 0) {
      return {
        code: p.code,
        message: stripped.slice(idx, idx + p.phrase.length),
        retryAfter: parseRetryAfter(stripped),
      };
    }
  }

  return null;
}

/** Codex harness fingerprint set. */
export const Patterns: PatternSet = {
  apiError: matchAPIError,
  cost: [
    "rate limit exceeded",
    "quota exceeded",
    "usage limit",
    "insufficient_quota",
    "you've hit your limit",
  ],
  retry: [
    "please try again",
    "server error",
    "upstream timed out",
    "temporary failure",
  ],
  prompt: ["(y/n)", "(yes/no)", "continue?", "approve change?", "apply patch?"],
};
