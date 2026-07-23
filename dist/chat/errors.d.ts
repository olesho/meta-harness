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
/**
 * Thrown by waitReadyForSend when the harness cannot reach a ready prompt because
 * it is sitting in a logged-out / not-onboarded screen (a sign-in wizard,
 * login-method picker, or re-auth banner) that never clears on its own. send()
 * catches it and records a terminal assistant turn carrying ReasonAuthRequired,
 * so the onboarding case surfaces the same canonical signal as the completion-
 * and error-path cases instead of hanging to the run deadline.
 */
export declare const ErrAuthRequired: Sentinel;
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
/**
 * Returned by setPermissionMode when the harness adapter implements no
 * permission-mode cycle keystroke at all (`opencode`, `pi`, `generic`).
 *
 * "This harness has no switch to throw" — a static property of the adapter, not
 * of the live session. Distinct from ErrPermissionModeUnreachable, which means
 * the switch exists but the requested target cannot be reached from here.
 */
export declare const ErrPermissionModeUnsupported: Sentinel;
/**
 * Returned by setPermissionMode when the harness CAN cycle, but the requested
 * target is not reachable in this session. The raiser attaches the concrete
 * evidence (observed axis value, `source`, `raw`, press count) to the message.
 *
 * Raised when:
 *   - `bypass` is requested without a bypass-enabling launch configuration;
 *   - the cycle ring lapped all the way round without landing on the target;
 *   - the target is off this harness's axis (a ladder rung on codex,
 *     `"default"` on claude);
 *   - the observed value is off-ladder but LEGIBLE — a non-empty `raw` with
 *     `observed: "unknown"` (a renamed mode such as `dontAsk`, or a codex
 *     `Custom (…)` pair). The screen was read fine; the session is simply
 *     somewhere the ladder does not describe.
 */
export declare const ErrPermissionModeUnreachable: Sentinel;
/**
 * Returned by setPermissionMode when the switch neither reached the target nor
 * proved it unreachable — the cycle did not make observable progress. The raiser
 * attaches the concrete evidence (observed axis value, `source`, `raw`, press
 * count) to the message.
 *
 * Raised when:
 *   - a press produced no stable axis change inside the settle bound;
 *   - the press backstop or the `ctx` deadline fired;
 *   - the reading is structurally ILLEGIBLE — `unparsed_footer`, `too_narrow`,
 *     `not_primed`, `not_written` or `written_uncaptured`. We could not see the
 *     axis, so no reachability claim can be made either way (contrast the
 *     legible-but-off-ladder case, which is ErrPermissionModeUnreachable).
 */
export declare const ErrPermissionModeStalled: Sentinel;
/** Returned by Open/Reopen when the harness adapter cannot build resume args. */
export declare const ErrResumeUnsupported: Sentinel;
/** Returned by Reopen when the stored session carries no harness session id. */
export declare const ErrNoHarnessSession: Sentinel;
export { isSentinel };
//# sourceMappingURL=errors.d.ts.map