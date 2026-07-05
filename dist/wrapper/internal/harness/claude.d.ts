import { type APIErrorHit, type Now, type Patterns as PatternSet, type SessionLimitHit } from "../detector/detector.ts";
/**
 * MatchAPIError implements an APIErrorMatcher for Claude Code. Returns the
 * parsed HTTP code (0 for the transport-error variant) and trimmed message, or
 * null on no match. A message starting with stray digits (malformed code) is
 * rejected.
 */
export declare function matchAPIError(stripped: string): APIErrorHit | null;
/** MatchSessionLimit implements a SessionLimitMatcher for Claude Code. */
export declare function matchSessionLimit(stripped: string, now: Now): SessionLimitHit | null;
/** Claude harness fingerprint set. */
export declare const Patterns: PatternSet;
//# sourceMappingURL=claude.d.ts.map