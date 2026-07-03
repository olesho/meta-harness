// Chat sentinels — the TS analogue of pkg/chat's Go sentinel errors.
//
// Each is a stable, identity-comparable Sentinel carrying a unique code. Tests
// assert membership with `isSentinel(err, ErrX)`, mirroring Go's
// errors.Is(err, ErrX): it walks the Error `cause` chain matching by code.

import { defineSentinel, isSentinel, type Sentinel } from "../internal/async/index.ts"

/** Returned by Open when Options is incomplete or inconsistent. */
export const ErrInvalidOptions: Sentinel = defineSentinel(
  "chat/invalid-options",
  "chat: invalid options",
)

/** Returned by Open when Options.Harness names no registered adapter. */
export const ErrUnknownHarness: Sentinel = defineSentinel(
  "chat/unknown-harness",
  "chat: unknown harness",
)

/** Returned by Send when no caller has acquired control. */
export const ErrNoControl: Sentinel = defineSentinel(
  "chat/no-control",
  "chat: control token not held",
)

/** Returned by Send when a previous assistant turn is still in flight. */
export const ErrTurnInFlight: Sentinel = defineSentinel(
  "chat/turn-in-flight",
  "chat: previous turn still in flight",
)

/** Returned by methods called after Close. */
export const ErrClosed: Sentinel = defineSentinel(
  "chat/closed",
  "chat: conversation closed",
)

/** Returned by Send when the harness is blocked on an interactive prompt. */
export const ErrInputPending: Sentinel = defineSentinel(
  "chat/input-pending",
  "chat: blocked on interactive input request",
)

/** Returned by Answer when no interactive prompt is currently pending. */
export const ErrNoInputPending: Sentinel = defineSentinel(
  "chat/no-input-pending",
  "chat: no input request pending",
)

/** Returned by Answer when the supplied request ID does not match the prompt. */
export const ErrStaleInputRequest: Sentinel = defineSentinel(
  "chat/stale-input-request",
  "chat: stale input request id",
)

/** Returned by Answer when the supplied option id/alias matches none. */
export const ErrUnknownOption: Sentinel = defineSentinel(
  "chat/unknown-option",
  "chat: unknown input option",
)

/** Returned by Quit when the harness adapter exposes no graceful-quit sequence. */
export const ErrQuitUnsupported: Sentinel = defineSentinel(
  "chat/quit-unsupported",
  "chat: harness has no graceful-quit sequence",
)

/** Returned by Open/Reopen when the harness adapter cannot build resume args. */
export const ErrResumeUnsupported: Sentinel = defineSentinel(
  "chat/resume-unsupported",
  "chat: harness has no resume sequence",
)

/** Returned by Reopen when the stored session carries no harness session id. */
export const ErrNoHarnessSession: Sentinel = defineSentinel(
  "chat/no-harness-session",
  "chat: session has no harness session id",
)

export { isSentinel }
