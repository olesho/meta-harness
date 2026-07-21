/** requiresPromptReadiness reports whether Send must wait for a ready prompt. */
export declare function requiresPromptReadiness(harness: string): boolean;
/** readyForInput reports whether the harness composer is ready for a message. */
export declare function readyForInput(harness: string, text: string): boolean;
/**
 * onboardingWall reports whether the screen is a first-run onboarding / sign-in
 * WIZARD that waits for menu input and never turns into a usable composer on its
 * own — distinct from a normal composer that merely shows a stale logged-out
 * banner. readyForInput uses it to keep send from typing a prompt into the
 * wizard, so the auth gate short-circuits with ReasonAuthRequired instead.
 */
export declare function onboardingWall(harness: string, text: string): boolean;
/**
 * usageLimitMessage returns the harness usage/session-limit wall line (its "out of
 * quota" screen, rendered in place of a reply) when present — trimmed, including
 * the "· resets …" tail — or null. Returns null for any harness without a known
 * wall (only claude-code today).
 */
export declare function usageLimitMessage(harness: string, text: string): string | null;
/**
 * authRequired reports whether the rendered screen shows a harness login-expiry /
 * logged-out banner OR a first-run onboarding wizard — either way the turn can
 * produce no assistant output until the human authenticates. Returns false for
 * any harness without a known banner set.
 */
export declare function authRequired(harness: string, text: string): boolean;
/** submitKeyForHarness pins the per-harness Enter key. */
export declare function submitKeyForHarness(harness: string, _screenText: string): Uint8Array;
//# sourceMappingURL=ready.d.ts.map