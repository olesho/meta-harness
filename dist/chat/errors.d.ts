import { isSentinel, type Sentinel } from "../internal/async/index.ts";
/** Returned by Open when Options is incomplete or inconsistent. */
export declare const ErrInvalidOptions: Sentinel;
/** Returned by Open when Options.Harness names no registered adapter. */
export declare const ErrUnknownHarness: Sentinel;
/** Returned by Send when no caller has acquired control. */
export declare const ErrNoControl: Sentinel;
/** Returned by Send when a previous assistant turn is still in flight. */
export declare const ErrTurnInFlight: Sentinel;
/** Returned by methods called after Close. */
export declare const ErrClosed: Sentinel;
/** Returned by Send when the harness is blocked on an interactive prompt. */
export declare const ErrInputPending: Sentinel;
/** Returned by Answer when no interactive prompt is currently pending. */
export declare const ErrNoInputPending: Sentinel;
/** Returned by Answer when the supplied request ID does not match the prompt. */
export declare const ErrStaleInputRequest: Sentinel;
/** Returned by Answer when the supplied option id/alias matches none. */
export declare const ErrUnknownOption: Sentinel;
/** Returned by Answer when optionIDs names several options on a single-select prompt. */
export declare const ErrNotMultiSelect: Sentinel;
/** Returned by Quit when the harness adapter exposes no graceful-quit sequence. */
export declare const ErrQuitUnsupported: Sentinel;
/** Returned by Open/Reopen when the harness adapter cannot build resume args. */
export declare const ErrResumeUnsupported: Sentinel;
/** Returned by Reopen when the stored session carries no harness session id. */
export declare const ErrNoHarnessSession: Sentinel;
export { isSentinel };
//# sourceMappingURL=errors.d.ts.map