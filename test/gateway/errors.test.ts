// Sentinel→HTTP mapping tests for src/gateway/errors.ts. Each row is asserted
// exactly, including the MH-only ErrNotMultiSelect→400 not_multi_select row and
// the run-turn context sentinels. Sentinels are matched through a `cause` chain
// (via isSentinel) to prove wrapping still resolves.

import { ServerResponse } from "node:http";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { describe, expect, test } from "vitest";

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
} from "../../src/chat/errors.ts";
import {
  ctxCanceled,
  ctxDeadlineExceeded,
  isSentinel,
  wrap,
} from "../../src/internal/async/index.ts";
import {
  mapChatError,
  mapRunTurnError,
  writeChatError,
  writeRunTurnError,
} from "../../src/gateway/errors.ts";
import {
  ErrTurnErrored,
  RunTurnError,
  type TurnResult,
} from "../../src/harness/index.ts";

/** Drive a writer against a fresh ServerResponse and capture status + body. */
function capture(
  writer: (res: ServerResponse, err: unknown) => void,
  err: unknown,
): { status: number; body: { code: string; message: string } } {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const chunks: Buffer[] = [];
  const origWrite = res.write.bind(res);
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (chunk) chunks.push(Buffer.from(chunk as string));
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;
  const origEnd = res.end.bind(res);
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (chunk) chunks.push(Buffer.from(chunk as string));
    return (origEnd as (...a: unknown[]) => ServerResponse)(chunk, ...rest);
  }) as typeof res.end;
  writer(res, err);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  return { status: res.statusCode, body };
}

describe("writeChatError — sentinel table", () => {
  const cases: [string, unknown, number, string][] = [
    ["ErrNoControl", ErrNoControl, 409, "no_control"],
    ["ErrTurnInFlight", ErrTurnInFlight, 409, "turn_in_flight"],
    ["ErrInputPending", ErrInputPending, 409, "input_pending"],
    ["ErrNoInputPending", ErrNoInputPending, 409, "no_input_pending"],
    ["ErrStaleInputRequest", ErrStaleInputRequest, 409, "stale_input_request"],
    ["ErrClosed", ErrClosed, 410, "gone"],
    ["ErrUnknownHarness", ErrUnknownHarness, 400, "unknown_harness"],
    ["ErrInvalidOptions", ErrInvalidOptions, 400, "invalid_options"],
    ["ErrUnknownOption", ErrUnknownOption, 400, "unknown_option"],
    ["ErrNotMultiSelect", ErrNotMultiSelect, 400, "not_multi_select"],
  ];

  test.each(cases)("%s → %d", (_name, err, status, code) => {
    expect(mapChatError(err)).toEqual({ status, code });
    const got = capture(writeChatError, err);
    expect(got.status).toBe(status);
    expect(got.body.code).toBe(code);
    expect(typeof got.body.message).toBe("string");
  });

  test("ErrNotMultiSelect maps to 400 not_multi_select, NOT 500", () => {
    const got = capture(writeChatError, ErrNotMultiSelect);
    expect(got.status).toBe(400);
    expect(got.body.code).toBe("not_multi_select");
  });

  test("ErrUnknownOption maps to 400 unknown_option", () => {
    expect(mapChatError(ErrUnknownOption)).toEqual({
      status: 400,
      code: "unknown_option",
    });
  });

  test("matches sentinel through a cause chain (isSentinel, not identity)", () => {
    const wrapped = wrap("send failed", ErrNoControl);
    expect(mapChatError(wrapped)).toEqual({ status: 409, code: "no_control" });
    const got = capture(writeChatError, wrapped);
    expect(got.status).toBe(409);
    expect(got.body.code).toBe("no_control");
  });

  test("unmatched error → 500 internal", () => {
    const got = capture(writeChatError, new Error("boom"));
    expect(got.status).toBe(500);
    expect(got.body.code).toBe("internal");
    expect(mapChatError(new Error("boom"))).toEqual({
      status: 500,
      code: "internal",
    });
  });
});

describe("writeRunTurnError — adds context sentinels", () => {
  test("ctxDeadlineExceeded → 504", () => {
    expect(mapRunTurnError(ctxDeadlineExceeded)).toEqual({
      status: 504,
      code: "timeout",
    });
    const got = capture(writeRunTurnError, ctxDeadlineExceeded);
    expect(got.status).toBe(504);
    expect(got.body.code).toBe("timeout");
  });

  test("ctxCanceled → 408", () => {
    expect(mapRunTurnError(ctxCanceled)).toEqual({
      status: 408,
      code: "canceled",
    });
    const got = capture(writeRunTurnError, ctxCanceled);
    expect(got.status).toBe(408);
    expect(got.body.code).toBe("canceled");
  });

  test("still delegates chat sentinels to the chat table", () => {
    expect(mapRunTurnError(ErrTurnInFlight)).toEqual({
      status: 409,
      code: "turn_in_flight",
    });
  });

  test("context sentinel through a cause chain resolves", () => {
    const got = capture(
      writeRunTurnError,
      wrap("run turn", ctxDeadlineExceeded),
    );
    expect(got.status).toBe(504);
    expect(got.body.code).toBe("timeout");
  });

  test("unmatched error → 500 internal", () => {
    const got = capture(writeRunTurnError, new Error("boom"));
    expect(got.status).toBe(500);
    expect(got.body.code).toBe("internal");
  });

  // §4: ErrTurnErrored is NOT a table row — an errored turn is a valid 200
  // outcome the /v1/turns HANDLER branches on (isSentinel + rebuild envelope),
  // not an error the mapper turns into a status. So mapRunTurnError leaves it on
  // the 500 fallback; the handler must intercept it before ever reaching here.
  test("RunTurnError(ErrTurnErrored) is NOT table-mapped (handler owns the 200)", () => {
    const zero = new Date(0);
    const result = {
      turn: {
        id: "t",
        sessionID: "s",
        role: "assistant",
        state: "errored",
        text: "",
        reason: "boom",
        startedAt: zero,
        completedAt: zero,
        httpCode: 0,
        retryAfter: 0,
      },
      session: {
        id: "s",
        harness: "claude-code",
        workingDir: "",
        createdAt: zero,
        harnessSessionID: "",
      },
      history: [],
      historySource: "store",
      processStoppedAfterTurn: false,
    } as TurnResult;
    const err = new RunTurnError(
      "harness: turn errored",
      ErrTurnErrored,
      result,
    );
    // The handler recognizes it via isSentinel …
    expect(isSentinel(err, ErrTurnErrored)).toBe(true);
    // … but the mapper does not: it falls through to the 500 fallback.
    expect(mapRunTurnError(err)).toEqual({ status: 500, code: "internal" });
  });
});
