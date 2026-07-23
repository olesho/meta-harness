// Chat sentinels — the TS analogue of pkg/chat's Go sentinel errors.
//
// Each is a stable, identity-comparable Sentinel carrying a unique code. Tests
// assert membership with `isSentinel(err, ErrX)`, mirroring Go's
// errors.Is(err, ErrX): it walks the Error `cause` chain matching by code.
import { defineSentinel, isSentinel, } from "../internal/async/index.js";
/** Returned by Open when Options is incomplete or inconsistent. */
export const ErrInvalidOptions = defineSentinel("chat/invalid-options", "chat: invalid options");
/** Returned by Open when Options.Harness names no registered adapter. */
export const ErrUnknownHarness = defineSentinel("chat/unknown-harness", "chat: unknown harness");
/** Returned by Send when no caller has acquired control. */
export const ErrNoControl = defineSentinel("chat/no-control", "chat: control token not held");
/** Returned by Send when a previous assistant turn is still in flight. */
export const ErrTurnInFlight = defineSentinel("chat/turn-in-flight", "chat: previous turn still in flight");
/** Returned by methods called after Close. */
export const ErrClosed = defineSentinel("chat/closed", "chat: conversation closed");
/** Returned by Send when the harness is blocked on an interactive prompt. */
export const ErrInputPending = defineSentinel("chat/input-pending", "chat: blocked on interactive input request");
/**
 * Thrown by waitReadyForSend when the harness cannot reach a ready prompt because
 * it is sitting in a logged-out / not-onboarded screen (a sign-in wizard,
 * login-method picker, or re-auth banner) that never clears on its own. send()
 * catches it and records a terminal assistant turn carrying ReasonAuthRequired,
 * so the onboarding case surfaces the same canonical signal as the completion-
 * and error-path cases instead of hanging to the run deadline.
 */
export const ErrAuthRequired = defineSentinel("chat/auth-required", "chat: harness requires authentication / onboarding");
/** Returned by Answer when no interactive prompt is currently pending. */
export const ErrNoInputPending = defineSentinel("chat/no-input-pending", "chat: no input request pending");
/** Returned by Answer when the supplied request ID does not match the prompt. */
export const ErrStaleInputRequest = defineSentinel("chat/stale-input-request", "chat: stale input request id");
/** Returned by Answer when the supplied option id/alias matches none. */
export const ErrUnknownOption = defineSentinel("chat/unknown-option", "chat: unknown input option");
/** Returned by Answer when optionIDs names several options on a single-select prompt. */
export const ErrNotMultiSelect = defineSentinel("chat/not-multi-select", "chat: prompt does not accept multiple selections");
/** Returned by Quit when the harness adapter exposes no graceful-quit sequence. */
export const ErrQuitUnsupported = defineSentinel("chat/quit-unsupported", "chat: harness has no graceful-quit sequence");
/**
 * Returned by setCodexPermissionPreset when the conversation cannot drive a
 * `/permissions` dialog at all: the harness is not `codex`, or the resolved
 * adapter exposes no permissions capability, or a caller-supplied
 * `Options.adapter` is in play alongside the permissions opt-in.
 *
 * The static-property counterpart of ErrQuitUnsupported, whose gate probes
 * `adapterQuitSequence()` and throws when it is absent — codex ships no
 * `quitSequence`, so that shape is live and exercised, not hypothetical. Here
 * too: "this conversation has no dialog to drive", decided from the adapter,
 * never from the live session.
 */
export const ErrPermissionsUnsupported = defineSentinel("chat/permissions-unsupported", "chat: harness has no permissions dialog");
/**
 * Returned by setCodexPermissionPreset when `Options.allowCodexPermissionsWrite`
 * is absent or empty.
 *
 * The feature is off by default because selecting a preset persists into the
 * user's GLOBAL `~/.codex/config.toml` and so affects unrelated later sessions,
 * not just this conversation. Opting in is the caller stating they accept that
 * blast radius.
 */
export const ErrCodexPermissionsDisabled = defineSentinel("chat/codex-permissions-disabled", "chat: codex permissions write not enabled");
/**
 * Returned by setCodexPermissionPreset when the containment gate fails: the
 * adapter was never bound to a launch env, or `CODEX_HOME` is unset in it, or
 * the bound `CODEX_HOME` does not match the isolated home the caller named, or
 * it resolves to `join(homedir(), ".codex")`.
 *
 * The gate FAILS CLOSED — an unbound adapter is a refusal, not a pass. We
 * cannot prove the write lands inside an isolated home, so we do not write.
 */
export const ErrCodexHomeNotIsolated = defineSentinel("chat/codex-home-not-isolated", "chat: CODEX_HOME is not an isolated home");
/**
 * Returned by setCodexPermissionPreset when a caller-supplied `onInputRequest`
 * answered the `permissions_prompt` first, so another writer already committed
 * a selection.
 *
 * The driver backs out rather than racing a second `answer()` against a dialog
 * that is already gone.
 */
export const ErrCodexPermissionsRaced = defineSentinel("chat/codex-permissions-raced", "chat: permissions prompt answered by another writer");
/**
 * Returned by setCodexPermissionPreset when the requested preset cannot be
 * selected: this codex build renders no row matching it, or the dialog never
 * opened at all.
 *
 * The first case is the `guardian_approval` feature flag being off or removed,
 * where the dialog renders e.g. `Read Only` / `Default` / `Custom permissions`
 * and simply has no "Approve for me" row. Without this sentinel that case would
 * leak out as ErrUnknownOption, which reads to a caller as "you passed a bad
 * id" rather than the truth, "this build lacks the preset". Raised via
 * `wrap(...)` with a message naming the requested preset and the rows observed.
 */
export const ErrPermissionPresetUnavailable = defineSentinel("chat/permission-preset-unavailable", "chat: permission preset unavailable");
/**
 * Returned by setPermissionMode when the harness adapter implements no
 * permission-mode cycle keystroke at all (`opencode`, `pi`, `generic`).
 *
 * "This harness has no switch to throw" — a static property of the adapter, not
 * of the live session. Distinct from ErrPermissionModeUnreachable, which means
 * the switch exists but the requested target cannot be reached from here.
 */
export const ErrPermissionModeUnsupported = defineSentinel("chat/permission-mode-unsupported", "chat: harness has no permission-mode cycle");
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
export const ErrPermissionModeUnreachable = defineSentinel("chat/permission-mode-unreachable", "chat: permission mode unreachable");
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
export const ErrPermissionModeStalled = defineSentinel("chat/permission-mode-stalled", "chat: permission mode did not settle");
/** Returned by Open/Reopen when the harness adapter cannot build resume args. */
export const ErrResumeUnsupported = defineSentinel("chat/resume-unsupported", "chat: harness has no resume sequence");
/** Returned by Reopen when the stored session carries no harness session id. */
export const ErrNoHarnessSession = defineSentinel("chat/no-harness-session", "chat: session has no harness session id");
export { isSentinel };
//# sourceMappingURL=errors.js.map