// Classifier patterns for the Claude Code CLI harness. Patterns are
// intentionally conservative: false positives here turn an active run into a
// stuck-looking one.

import {
  parseResetTime,
  parseRetryAfter,
  type APIErrorHit,
  type Now,
  type Patterns as PatternSet,
  type SessionLimitHit,
} from "../detector/detector.ts";

// horizontalSpace accepts ASCII space/tab and NBSP — Claude Code commonly uses
// U+00A0 after its tree-character decoration.
const horizontalSpace = `[\\t \\u00A0]`;
const glyphs = `[⎿│├└╰─◯⏺]`;

// apiErrorRE matches Claude Code's two API-error rendering shapes (with code,
// and code-less transport errors), optionally preceded by a decoration glyph.
const apiErrorRE = new RegExp(
  `^${horizontalSpace}*(?:${glyphs}${horizontalSpace}*)?API Error:${horizontalSpace}*(?:(\\d{3})\\b${horizontalSpace}+)?(.*)$`,
  "im",
);

/**
 * MatchAPIError implements an APIErrorMatcher for Claude Code. Returns the
 * parsed HTTP code (0 for the transport-error variant) and trimmed message, or
 * null on no match. A message starting with stray digits (malformed code) is
 * rejected.
 */
export function matchAPIError(stripped: string): APIErrorHit | null {
  const m = apiErrorRE.exec(stripped);
  if (!m) return null;
  const message = (m[2] ?? "").trim();
  const hit: APIErrorHit = { code: 0, message, retryAfter: 0 };
  if (m[1]) {
    hit.code = parseInt(m[1], 10);
  } else if (message.length > 0 && message[0] >= "0" && message[0] <= "9") {
    return null;
  }
  hit.retryAfter = parseRetryAfter(message);
  return hit;
}

// sessionLimitRE matches "You've hit your session limit · resets 6:40pm (...)",
// possibly wrapped in a tool-result decoration glyph.
const sessionLimitRE = new RegExp(
  `^${horizontalSpace}*(?:${glyphs}${horizontalSpace}*)?(You(?:'ve|\\s+have)\\s+hit\\s+your\\s+(?:session|usage)\\s+limit.*)$`,
  "im",
);

/** MatchSessionLimit implements a SessionLimitMatcher for Claude Code. */
export function matchSessionLimit(
  stripped: string,
  now: Now,
): SessionLimitHit | null {
  const m = sessionLimitRE.exec(stripped);
  if (!m) return null;
  const message = m[1].trim();
  return { message, resumeAt: parseResetTime(message, now) };
}

/** Claude harness fingerprint set. */
export const Patterns: PatternSet = {
  apiError: matchAPIError,
  sessionLimit: matchSessionLimit,
  cost: [
    "you've hit your limit",
    "you have hit your limit",
    "you've hit your session limit",
    "you have hit your session limit",
    "you've hit your usage limit",
    "you have hit your usage limit",
    "limit resets",
    "resets at",
    "usage limit",
    "rate limit",
    "rate-limit",
    "quota exceeded",
  ],
  retry: [
    "please try again",
    "transient error",
    "temporary failure",
    "network error",
    "upstream error",
  ],
  prompt: [
    "(y/n)",
    "(y/n/a)",
    "(yes/no)",
    "continue?",
    "continue? [y/n]",
    "approve?",
    "do you want to continue?",
  ],
};
