// Gateway error mapping — the sentinel→HTTP contract for meta-harness-chatd.
// Ported from the Go `cmd/harness-chatd` `server.go` (writeChatError /
// writeRunTurnError), but with two deliberate MH divergences:
//
//   1. MATCHING MECHANISM. Go uses `errors.Is(err, ErrX)`. MH matches sentinels
//      via `isSentinel(err, ErrX)`, which walks the Error `cause` chain by code.
//      `isSentinel` is imported from `src/chat/errors.ts` (NOT the `src/chat`
//      barrel, which deliberately omits it) alongside the sentinels themselves.
//
//   2. MH-ONLY ROW: ErrNotMultiSelect → 400 not_multi_select. Go has no
//      multi-select, so its table never mapped it. Because the superset answer
//      DTO makes the multi-select path reachable over HTTP, a malformed
//      multi-select answer throws ErrNotMultiSelect on the `answer` path; without
//      this row it would fall through to a generic 500.
//
// The table is EXPLICIT and ORDERED. Each entry maps a sentinel to {status,code}.

import type { ServerResponse } from "node:http"

import {
  ErrClosed,
  ErrInputPending,
  ErrInvalidOptions,
  ErrNoControl,
  ErrNoInputPending,
  ErrNotMultiSelect,
  ErrStaleInputRequest,
  ErrTurnInFlight,
  ErrUnknownHarness,
  ErrUnknownOption,
  isSentinel,
} from "../chat/errors.ts"
import {
  ctxCanceled,
  ctxDeadlineExceeded,
  type Sentinel,
} from "../internal/async/index.ts"

/** An HTTP outcome: numeric status + stable machine-readable code. */
export interface ErrorMapping {
  status: number
  code: string
}

/** One row of the ordered sentinel→mapping table. */
interface SentinelRow {
  sentinel: Sentinel
  status: number
  code: string
}

// Ordered sentinel→{status,code} table shared by both writers. Order is honored
// via first-match, mirroring Go's switch. Codes match Go's writeChatError where
// Go maps the sentinel; ErrClosed→gone and ErrNotMultiSelect→not_multi_select
// are the MH-specified codes.
const CHAT_ERROR_TABLE: readonly SentinelRow[] = [
  { sentinel: ErrNoControl, status: 409, code: "no_control" },
  { sentinel: ErrTurnInFlight, status: 409, code: "turn_in_flight" },
  { sentinel: ErrInputPending, status: 409, code: "input_pending" },
  { sentinel: ErrNoInputPending, status: 409, code: "no_input_pending" },
  { sentinel: ErrStaleInputRequest, status: 409, code: "stale_input_request" },
  { sentinel: ErrClosed, status: 410, code: "gone" },
  { sentinel: ErrUnknownHarness, status: 400, code: "unknown_harness" },
  { sentinel: ErrInvalidOptions, status: 400, code: "invalid_options" },
  { sentinel: ErrUnknownOption, status: 400, code: "unknown_option" },
  // MH-ONLY — DO NOT OMIT. Keeps a malformed multi-select answer off the 500 path.
  { sentinel: ErrNotMultiSelect, status: 400, code: "not_multi_select" },
]

// Context sentinels writeRunTurnError maps in ADDITION to the chat table, ahead
// of it (a run-turn timeout/cancel is not a chat sentinel).
const RUN_TURN_TABLE: readonly SentinelRow[] = [
  { sentinel: ctxDeadlineExceeded, status: 504, code: "timeout" },
  { sentinel: ctxCanceled, status: 408, code: "canceled" },
]

/** Fallback for any error matching no sentinel row. */
const FALLBACK: ErrorMapping = { status: 500, code: "internal" }

/** Extract a human-readable message from a thrown value. */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  return String(err)
}

/** First-match lookup over an ordered table using isSentinel (cause-chain aware). */
function lookup(err: unknown, table: readonly SentinelRow[]): ErrorMapping | undefined {
  for (const row of table) {
    if (isSentinel(err, row.sentinel)) {
      return { status: row.status, code: row.code }
    }
  }
  return undefined
}

/** Map a chat-path error to its HTTP outcome (exported for testing/reuse). */
export function mapChatError(err: unknown): ErrorMapping {
  return lookup(err, CHAT_ERROR_TABLE) ?? FALLBACK
}

/** Map a run-turn-path error: context sentinels first, then the chat table. */
export function mapRunTurnError(err: unknown): ErrorMapping {
  return lookup(err, RUN_TURN_TABLE) ?? mapChatError(err)
}

/** Write a JSON error body `{ code, message }` with the given status. */
function writeError(res: ServerResponse, mapping: ErrorMapping, message: string): void {
  const body = JSON.stringify({ code: mapping.code, message })
  res.statusCode = mapping.status
  res.setHeader("Content-Type", "application/json")
  res.end(body)
}

/** writeChatError: map a thrown chat error and write its JSON body. */
export function writeChatError(res: ServerResponse, err: unknown): void {
  writeError(res, mapChatError(err), messageOf(err))
}

/**
 * writeRunTurnError: like writeChatError but ALSO maps the context sentinels
 * (ctxDeadlineExceeded→504, ctxCanceled→408) before falling back to the chat
 * table. Ported from Go's writeRunTurnError.
 */
export function writeRunTurnError(res: ServerResponse, err: unknown): void {
  writeError(res, mapRunTurnError(err), messageOf(err))
}
