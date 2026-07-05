/** A wall-clock instant paired with the IANA zone used to resolve it. */
export interface Now {
    /** The absolute instant ("now"). */
    date: Date;
    /** IANA timezone name used when a banner omits its own TZ. */
    zone: string;
}
/** What an APIErrorMatcher returns when it recognizes an upstream API error. */
export interface APIErrorHit {
    /** HTTP status code, or 0 when the output had no numeric code. */
    code: number;
    /** Human-readable detail extracted from the matched line. */
    message: string;
    /** Suggested wait in milliseconds, or 0 when no hint was parseable. */
    retryAfter: number;
}
/** Inspects already-ANSI-stripped output for a recognized API error. */
export type APIErrorMatcher = (stripped: string) => APIErrorHit | null;
/** What a SessionLimitMatcher returns on a session-limit banner. */
export interface SessionLimitHit {
    /** Human-readable detail extracted from the matched banner. */
    message: string;
    /** Absolute reset instant, or null when none was parseable. */
    resumeAt: Date | null;
}
/** Inspects already-ANSI-stripped output for a recognized session-limit banner. */
export type SessionLimitMatcher = (stripped: string, now: Now) => SessionLimitHit | null;
/** Per-harness fingerprints a classifier consults. */
export interface Patterns {
    cost?: string[];
    retry?: string[];
    prompt?: string[];
    apiError?: APIErrorMatcher | null;
    sessionLimit?: SessionLimitMatcher | null;
}
/**
 * Scan an API-error message for a numeric retry hint and return it as a
 * duration in milliseconds. Returns 0 when no hint was found or the unit was
 * not recognized.
 */
export declare function parseRetryAfter(msg: string): number;
/**
 * Scan text for a "resets HH:MM(am|pm) (TZ)" hint and return the next future
 * absolute instant at which the limit is expected to reset. Returns null when
 * no parseable hint was found.
 */
export declare function parseResetTime(text: string, now: Now): Date | null;
/**
 * Return the first pattern that appears as a substring of `haystack`, or "" if
 * none match. Caller is expected to pre-lowercase `haystack`.
 */
export declare function matchAny(haystack: string, patterns: string[] | undefined): string;
/**
 * Return the first pattern that the trailing non-empty line of `haystack` ends
 * with (case-insensitive), or "" if none match.
 */
export declare function matchPromptSuffix(haystack: string, patterns: string[] | undefined): string;
//# sourceMappingURL=detector.d.ts.map