import { expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { CodexReader } from "../../../src/transcript/codex/codex.ts";
import { tempDir } from "../tmp.ts";

test("read against fixture", () => {
  const dir = tempDir();
  const root = path.join(dir, "sessions", "2026", "05", "14");
  mkdirSync(root, { recursive: true });
  const body = `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}
{"type":"other"}
`;
  writeFileSync(
    path.join(root, "rollout-2026-05-14T12-00-00-abc-def-ghi.jsonl"),
    body,
  );

  const r = new CodexReader(path.join(dir, "sessions"));
  const turns = r.read("abc-def-ghi", "/unused");
  expect(turns).toHaveLength(2);
  expect(turns[0].role).toBe("user");
  expect(turns[0].text).toBe("hello");
  expect(turns[1].role).toBe("assistant");
  expect(turns[1].text).toBe("hi there");
});

test("read missing session errors", () => {
  const r = new CodexReader(tempDir());
  expect(() => r.read("missing", "")).toThrow();
});

// --- resolveRoot precedence: explicit > $CODEX_HOME > ~/.codex/sessions ------
//
// Hermetic by construction: withCodexHome saves the ambient CODEX_HOME (set or
// unset) and restores it in a finally, so neither the fallback nor its absence
// leaks into sibling tests in this file or the wider run.
function withCodexHome<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.CODEX_HOME;
  if (value === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
}

test("resolveRoot falls back to $CODEX_HOME/sessions", () => {
  const home = tempDir();
  withCodexHome(home, () => {
    expect(new CodexReader().resolveRoot()).toBe(path.join(home, "sessions"));
  });
});

test("resolveRoot: explicit sessionsRoot beats $CODEX_HOME", () => {
  const explicit = tempDir();
  withCodexHome(tempDir(), () => {
    expect(new CodexReader(explicit).resolveRoot()).toBe(explicit);
  });
});

test("resolveRoot: empty $CODEX_HOME is treated as unset", () => {
  withCodexHome("", () => {
    expect(new CodexReader().resolveRoot()).toBe(
      path.join(homedir(), ".codex", "sessions"),
    );
  });
});

test("resolveRoot defaults to ~/.codex/sessions with no CODEX_HOME", () => {
  withCodexHome(undefined, () => {
    expect(new CodexReader().resolveRoot()).toBe(
      path.join(homedir(), ".codex", "sessions"),
    );
  });
});

// End-to-end through the fallback: a rollout written under an isolated home is
// found by a reader constructed with NO root — the structured-runner shape.
test("read resolves a session under an isolated CODEX_HOME", () => {
  const home = tempDir();
  const day = path.join(home, "sessions", "2026", "07", "23");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(day, "rollout-2026-07-23T09-00-00-iso-home-uuid.jsonl"),
    `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}}\n`,
  );

  withCodexHome(home, () => {
    const turns = new CodexReader().read("iso-home-uuid", "/unused");
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("ping");
  });
});
