import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  usageFromClaudeJSONL,
  usageFromCodexJSONL,
  usageToPublicJSON,
  type Usage,
} from "../../src/transcript/usage.ts";
import {
  ClaudeCodeReader,
  encodedCWD,
} from "../../src/transcript/claudecode/claudecode.ts";
import { CodexReader } from "../../src/transcript/codex/codex.ts";
import { tempDir } from "./tmp.ts";

function claudeLine(
  msgID: string,
  usage: Record<string, unknown>,
  uuid = "u-" + msgID,
): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    message: {
      id: msgID,
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      usage,
    },
  });
}

describe("usageFromClaudeJSONL", () => {
  test("sums across API calls, deduping repeated message ids", () => {
    // One API call split across two content-block lines (same message id, same
    // usage — the shape real transcripts have), plus a second distinct call.
    const body = [
      claudeLine(
        "msg_1",
        {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7,
        },
        "u1",
      ),
      claudeLine(
        "msg_1",
        {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7,
        },
        "u2",
      ),
      claudeLine(
        "msg_2",
        {
          input_tokens: 40,
          output_tokens: 4,
          cache_read_input_tokens: 105,
          cache_creation_input_tokens: 0,
        },
        "u3",
      ),
    ].join("\n");
    expect(usageFromClaudeJSONL(body)).toEqual({
      inputTokens: 140,
      outputTokens: 14,
      cacheReadInputTokens: 110,
      cacheCreationInputTokens: 7,
      reasoningOutputTokens: 0,
    });
  });

  test("falls back to line uuid when the message has no id", () => {
    const noID = (uuid: string, tokens: number) =>
      JSON.stringify({
        type: "assistant",
        uuid,
        message: {
          role: "assistant",
          content: [],
          usage: { input_tokens: tokens, output_tokens: 1 },
        },
      });
    const u = usageFromClaudeJSONL([noID("a", 10), noID("b", 20)].join("\n"));
    expect(u?.inputTokens).toBe(30);
    expect(u?.outputTokens).toBe(2);
  });

  test("ignores user lines, malformed lines, and non-numeric fields", () => {
    const body = [
      `{"type":"user","uuid":"u0","message":{"role":"user","content":"hi","usage":{"input_tokens":999}}}`,
      "not json at all",
      claudeLine("msg_1", { input_tokens: "NaN?", output_tokens: 3 }),
    ].join("\n");
    expect(usageFromClaudeJSONL(body)).toEqual({
      inputTokens: 0,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    });
  });

  test("null when no assistant line carries usage", () => {
    const body = [
      `{"type":"user","uuid":"u0","message":{"role":"user","content":"hi"}}`,
      `{"type":"assistant","uuid":"u1","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"y"}]}}`,
    ].join("\n");
    expect(usageFromClaudeJSONL(body)).toBeNull();
    expect(usageFromClaudeJSONL("")).toBeNull();
  });
});

function codexTokenCount(total: Record<string, unknown> | null): string {
  return JSON.stringify({
    timestamp: "2026-07-06T12:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info:
        total === null
          ? null
          : { total_token_usage: total, last_token_usage: {} },
    },
  });
}

describe("usageFromCodexJSONL", () => {
  test("takes the LAST token_count's cumulative totals", () => {
    const body = [
      codexTokenCount({
        input_tokens: 100,
        cached_input_tokens: 50,
        output_tokens: 10,
        reasoning_output_tokens: 2,
        total_tokens: 110,
      }),
      `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}`,
      codexTokenCount({
        input_tokens: 430,
        cached_input_tokens: 380,
        output_tokens: 33,
        reasoning_output_tokens: 6,
        total_tokens: 463,
      }),
    ].join("\n");
    expect(usageFromCodexJSONL(body)).toEqual({
      inputTokens: 430,
      outputTokens: 33,
      cacheReadInputTokens: 380,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 6,
    });
  });

  test("skips token_count events with null info (early events)", () => {
    const body = [
      codexTokenCount(null),
      codexTokenCount({
        input_tokens: 7,
        cached_input_tokens: 0,
        output_tokens: 1,
      }),
      codexTokenCount(null),
    ].join("\n");
    expect(usageFromCodexJSONL(body)?.inputTokens).toBe(7);
  });

  test("null when the rollout has no usable token_count", () => {
    expect(usageFromCodexJSONL(codexTokenCount(null))).toBeNull();
    expect(
      usageFromCodexJSONL(`{"type":"response_item","payload":{}}`),
    ).toBeNull();
    expect(usageFromCodexJSONL("")).toBeNull();
  });
});

test("usageToPublicJSON maps to snake_case wire keys", () => {
  const u: Usage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 4,
    reasoningOutputTokens: 5,
  };
  expect(usageToPublicJSON(u)).toEqual({
    input_tokens: 1,
    output_tokens: 2,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
    reasoning_output_tokens: 5,
  });
});

describe("Reader.readUsage", () => {
  test("ClaudeCodeReader.readUsage reads totals from the session file", () => {
    const dir = tempDir();
    const cwd = "/some/work/dir";
    const projDir = path.join(dir, "projects", encodedCWD(cwd));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      path.join(projDir, "sess-uuid.jsonl"),
      claudeLine("msg_1", {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 56,
        cache_creation_input_tokens: 78,
      }) + "\n",
    );
    const r = new ClaudeCodeReader(path.join(dir, "projects"));
    expect(r.readUsage("sess-uuid", cwd)).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadInputTokens: 56,
      cacheCreationInputTokens: 78,
      reasoningOutputTokens: 0,
    });
    expect(() => r.readUsage("", cwd)).toThrow();
    expect(() => r.readUsage("sess-uuid", "")).toThrow();
    expect(() => r.readUsage("missing", cwd)).toThrow();
  });

  test("CodexReader.readUsage reads cumulative totals from the rollout", () => {
    const dir = tempDir();
    const root = path.join(dir, "sessions", "2026", "07", "06");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "rollout-2026-07-06T12-00-00-abc-def-ghi.jsonl"),
      codexTokenCount({
        input_tokens: 430,
        cached_input_tokens: 380,
        output_tokens: 33,
        reasoning_output_tokens: 6,
      }) + "\n",
    );
    const r = new CodexReader(path.join(dir, "sessions"));
    expect(r.readUsage("abc-def-ghi")).toEqual({
      inputTokens: 430,
      outputTokens: 33,
      cacheReadInputTokens: 380,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 6,
    });
    expect(() => r.readUsage("")).toThrow();
    expect(() => r.readUsage("missing")).toThrow();
  });

  test("readUsage returns null when the session records no usage", () => {
    const dir = tempDir();
    const cwd = "/some/work/dir";
    const projDir = path.join(dir, "projects", encodedCWD(cwd));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      path.join(projDir, "sess-uuid.jsonl"),
      `{"type":"assistant","uuid":"u1","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"y"}]}}\n`,
    );
    const r = new ClaudeCodeReader(path.join(dir, "projects"));
    expect(r.readUsage("sess-uuid", cwd)).toBeNull();
  });
});
