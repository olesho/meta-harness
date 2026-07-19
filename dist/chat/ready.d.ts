/** requiresPromptReadiness reports whether Send must wait for a ready prompt. */
export declare function requiresPromptReadiness(harness: string): boolean;
/** readyForInput reports whether the harness composer is ready for a message. */
export declare function readyForInput(harness: string, text: string): boolean;
/**
 * authRequired reports whether the rendered screen shows a harness login-expiry /
 * logged-out banner. Callers MUST gate this on a turn that produced no clean
 * assistant output — it is a failure EXPLANATION, not a turn-completion signal.
 * Returns false for any harness without a known banner set.
 */
export declare function authRequired(harness: string, text: string): boolean;
/** submitKeyForHarness pins the per-harness Enter key. */
export declare function submitKeyForHarness(harness: string, _screenText: string): Uint8Array;
//# sourceMappingURL=ready.d.ts.map