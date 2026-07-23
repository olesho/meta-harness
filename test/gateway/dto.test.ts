// Wire-DTO tests for src/gateway/dto.ts — the retry_after duration formatting,
// the InputRequest superset round-trip, and the answerRequest option_ids parse.

import { describe, expect, test } from "vitest";

import {
  goDurationString,
  inputRequestDTO,
  parseAnswerRequest,
  permissionModeResponse,
  screenResponse,
  sessionDTO,
  turnDTO,
} from "../../src/gateway/dto.ts";
import type { InputRequest, Session, Turn } from "../../src/chat/types.ts";
import type { PermissionModeReading } from "../../src/chat/permission.ts";
import type { Snapshot } from "../../src/screen/screen.ts";

function baseTurn(over: Partial<Turn> = {}): Turn {
  return {
    id: "t1",
    sessionID: "s1",
    role: "assistant",
    state: "complete",
    text: "hi",
    reason: "",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:00:05.000Z"),
    httpCode: 0,
    retryAfter: 0,
    ...over,
  };
}

describe("goDurationString — Go duration formatting", () => {
  test("whole seconds", () => {
    expect(goDurationString(30000)).toBe("30s");
  });
  test("minutes + seconds", () => {
    expect(goDurationString(90000)).toBe("1m30s");
  });
  test("exact minute keeps the 0s", () => {
    expect(goDurationString(120000)).toBe("2m0s");
  });
  test("hours + minutes + seconds", () => {
    expect(goDurationString(3661000)).toBe("1h1m1s");
  });
  test("fractional seconds", () => {
    expect(goDurationString(1500)).toBe("1.5s");
  });
  test("milliseconds sub-second", () => {
    expect(goDurationString(200)).toBe("200ms");
  });
  test("zero", () => {
    expect(goDurationString(0)).toBe("0s");
  });
});

describe("turnDTO", () => {
  test("formats retry_after as a Go duration string from ms", () => {
    const dto = turnDTO(baseTurn({ retryAfter: 30000 }));
    expect(dto.retry_after).toBe("30s");
  });

  test("omits retry_after when zero", () => {
    const dto = turnDTO(baseTurn({ retryAfter: 0 }));
    expect(dto.retry_after).toBeUndefined();
  });

  test("maps camelCase to snake_case and carries http_code", () => {
    const dto = turnDTO(baseTurn({ httpCode: 429, sessionID: "sess-9" }));
    expect(dto.session_id).toBe("sess-9");
    expect(dto.http_code).toBe(429);
    expect(dto.started_at).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.completed_at).toBe("2026-01-01T00:00:05.000Z");
  });

  test("omits completed_at for a zero (epoch) completion time", () => {
    const dto = turnDTO(baseTurn({ completedAt: new Date(0) }));
    expect(dto.completed_at).toBeUndefined();
  });
});

describe("inputRequestDTO — superset round-trip", () => {
  test("exposes header, multi_select, and per-option description", () => {
    const req: InputRequest = {
      id: "r1",
      kind: "question",
      prompt: "Pick some",
      header: "Choose",
      multiSelect: true,
      options: [
        { id: "o1", alias: "a", label: "First", description: "the first one" },
        { id: "o2", label: "Second" },
      ],
    };
    const dto = inputRequestDTO(req);
    expect(dto.header).toBe("Choose");
    expect(dto.multi_select).toBe(true);
    expect(dto.options?.[0]).toEqual({
      id: "o1",
      alias: "a",
      label: "First",
      description: "the first one",
    });
    expect(dto.options?.[1]).toEqual({ id: "o2", label: "Second" });
  });

  test("omits superset fields when absent (single-select)", () => {
    const req: InputRequest = { id: "r2", kind: "trust_prompt", prompt: "OK?" };
    const dto = inputRequestDTO(req);
    expect(dto.header).toBeUndefined();
    expect(dto.multi_select).toBeUndefined();
    expect(dto.options).toBeUndefined();
  });
});

describe("parseAnswerRequest", () => {
  test("maps option_ids[] to optionIDs (multi-select)", () => {
    const ans = parseAnswerRequest({ option_ids: ["a", "b"] });
    expect(ans.optionIDs).toEqual(["a", "b"]);
  });

  test("option_ids takes precedence over option_id when non-empty", () => {
    const ans = parseAnswerRequest({ option_ids: ["a"], option_id: "z" });
    expect(ans.optionIDs).toEqual(["a"]);
    expect(ans.optionID).toBe("z"); // still carried, but optionIDs wins downstream
  });

  test("empty option_ids falls back to option_id", () => {
    const ans = parseAnswerRequest({ option_ids: [], option_id: "z" });
    expect(ans.optionIDs).toBeUndefined();
    expect(ans.optionID).toBe("z");
  });

  test("maps option_id and text", () => {
    const ans = parseAnswerRequest({ option_id: "yes", text: "why" });
    expect(ans.optionID).toBe("yes");
    expect(ans.text).toBe("why");
  });
});

describe("screenResponse + sessionDTO", () => {
  test("screenResponse maps snapshot fields to snake_case", () => {
    const snap: Snapshot = {
      text: "hello",
      cols: 80,
      rows: 24,
      cursorCol: 5,
      cursorRow: 2,
      generation: 7,
    };
    expect(screenResponse(snap)).toEqual({
      text: "hello",
      cols: 80,
      rows: 24,
      cursor_col: 5,
      cursor_row: 2,
      generation: 7,
    });
  });

  test("sessionDTO maps Session fields", () => {
    const s: Session = {
      id: "sess-1",
      harness: "claude",
      workingDir: "/w",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      harnessSessionID: "hx",
    };
    expect(sessionDTO(s)).toEqual({
      id: "sess-1",
      harness: "claude",
      working_dir: "/w",
      created_at: "2026-01-01T00:00:00.000Z",
      harness_session_id: "hx",
    });
  });
});

describe("permissionModeResponse", () => {
  const base: PermissionModeReading = {
    observed: "acceptEdits",
    source: "status",
    generation: 12,
    observedAt: new Date("2026-07-22T18:04:11.220Z"),
  };

  test("full reading → snake_case KEYS, verbatim VALUES, stale computed", () => {
    expect(
      permissionModeResponse(
        {
          ...base,
          requested: "bypass",
          requestedRaw: "bypassPermissions",
          raw: "Workspace (Approve for me)",
          collaboration: "default",
        },
        4711,
      ),
    ).toEqual({
      requested: "bypass",
      requested_raw: "bypassPermissions",
      observed: "acceptEdits",
      raw: "Workspace (Approve for me)",
      collaboration: "default",
      source: "status",
      generation: 12,
      current_generation: 4711,
      stale: true,
      observed_at: "2026-07-22T18:04:11.220Z",
    });
  });

  test("casing is pinned: rung values stay camelCase, source values stay snake_case", () => {
    const out = permissionModeResponse(
      {
        ...base,
        requested: "acceptEdits",
        observed: "acceptEdits",
        source: "written_uncaptured",
      },
      12,
    );
    // Rungs are the TS spelling verbatim, so they round-trip unchanged.
    expect(out.requested).toBe("acceptEdits");
    expect(out.observed).toBe("acceptEdits");
    // Sources are primeOutcome's vocabulary verbatim.
    expect(out.source).toBe("written_uncaptured");
    // Only KEYS are snake_case.
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining([
        "current_generation",
        "observed_at",
        "generation",
        "stale",
      ]),
    );
  });

  test("stale is a pure generation comparison — equal generations → false", () => {
    expect(permissionModeResponse(base, 12).stale).toBe(false);
    expect(permissionModeResponse(base, 13).stale).toBe(true);
    // A LOWER current generation is still a mismatch, never a special case.
    expect(permissionModeResponse(base, 11).stale).toBe(true);
  });

  test("requested / requested_raw / raw / collaboration are omitted when empty", () => {
    const out = permissionModeResponse(
      { ...base, observed: "unknown", source: "launch" },
      12,
    );
    expect(out).toEqual({
      observed: "unknown",
      source: "launch",
      generation: 12,
      current_generation: 12,
      stale: false,
      observed_at: "2026-07-22T18:04:11.220Z",
    });
    for (const k of ["requested", "requested_raw", "raw", "collaboration"]) {
      expect(Object.hasOwn(out, k)).toBe(false);
    }
  });

  test('empty-string raw / requestedRaw are omitted, not emitted as ""', () => {
    const out = permissionModeResponse(
      { ...base, raw: "", requestedRaw: "", collaboration: undefined },
      12,
    );
    expect(Object.hasOwn(out, "raw")).toBe(false);
    expect(Object.hasOwn(out, "requested_raw")).toBe(false);
  });

  test("off-ladder: unknown observed WITH raw survives encoding", () => {
    // The whole point of shipping `raw`: distinguishes "outside the ladder"
    // from "couldn't see", which is unknown with NO raw.
    const seen = permissionModeResponse(
      { ...base, observed: "unknown", raw: "Workspace (Approve for me)" },
      12,
    );
    expect(seen.observed).toBe("unknown");
    expect(seen.raw).toBe("Workspace (Approve for me)");
    const blind = permissionModeResponse(
      { ...base, observed: "unknown", source: "no_footer" },
      12,
    );
    expect(blind.observed).toBe("unknown");
    expect(Object.hasOwn(blind, "raw")).toBe(false);
    expect(blind.source).toBe("no_footer");
  });
});
