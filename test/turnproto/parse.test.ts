// Tier-1 suite for the fresh last-stdout-line JSON parser. No producer parses
// this JSON today (orche consumes the whole stdout; loomcli's parse is spec'd
// not shipped), so this is brand-new coverage.

import { describe, expect, test } from "vitest";

import { parseLastJSONLine } from "../../src/turnproto/index.ts";

const payload = {
  status: "completed",
  reply: "hello",
  harnessSessionID: "abc",
  transcript_entries: [],
  working_dir: "/repo",
};
const line = JSON.stringify(payload);

describe("parseLastJSONLine", () => {
  test("parses a clean single JSON line", () => {
    expect(parseLastJSONLine(line + "\n")).toEqual(payload);
  });

  test("tolerates noise BEFORE the JSON line", () => {
    const stdout = "harness banner\nwarning: something\n" + line + "\n";
    expect(parseLastJSONLine(stdout)).toEqual(payload);
  });

  test("returns the LAST JSON object when there are multiple", () => {
    const first = JSON.stringify({ ...payload, reply: "first" });
    const stdout = first + "\n" + line + "\n";
    expect(parseLastJSONLine(stdout)?.reply).toBe("hello");
  });

  test("skips a NON-JSON tail after the JSON line", () => {
    const stdout = line + "\nGoodbye (not json)\n";
    expect(parseLastJSONLine(stdout)).toEqual(payload);
  });

  test("skips a TRUNCATED final line and finds the prior valid JSON", () => {
    const truncated = line.slice(0, line.length - 5); // chopped tail → invalid
    const stdout = line + "\n" + truncated;
    expect(parseLastJSONLine(stdout)).toEqual(payload);
  });

  test("returns null when the ONLY JSON line is truncated", () => {
    const truncated = line.slice(0, line.length - 5);
    expect(parseLastJSONLine("noise\n" + truncated)).toBeNull();
  });

  test("returns null on ZERO JSON (all noise)", () => {
    expect(parseLastJSONLine("no json here\njust logs\n")).toBeNull();
  });

  test("returns null on empty stdout", () => {
    expect(parseLastJSONLine("")).toBeNull();
  });

  test("rejects bare JSON scalars and arrays (payload is always an object)", () => {
    expect(parseLastJSONLine("42\n")).toBeNull();
    expect(parseLastJSONLine('"a string"\n')).toBeNull();
    expect(parseLastJSONLine("[1,2,3]\n")).toBeNull();
    expect(parseLastJSONLine("null\n")).toBeNull();
  });

  test("ignores blank/whitespace lines around the payload", () => {
    expect(parseLastJSONLine("\n  \n" + line + "\n   \n")).toEqual(payload);
  });
});
