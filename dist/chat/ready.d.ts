/** requiresPromptReadiness reports whether Send must wait for a ready prompt. */
export declare function requiresPromptReadiness(harness: string): boolean;
/** readyForInput reports whether the harness composer is ready for a message. */
export declare function readyForInput(harness: string, text: string): boolean;
/** submitKeyForHarness pins the per-harness Enter key. */
export declare function submitKeyForHarness(harness: string, _screenText: string): Uint8Array;
//# sourceMappingURL=ready.d.ts.map