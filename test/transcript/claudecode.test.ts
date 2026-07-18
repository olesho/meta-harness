import { expect, test } from "vitest";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  EventText,
  EventToolResult,
  EventToolUse,
  SourceFile,
  eventID,
} from "../../src/transcript/event.ts";
import {
  ClaudeCodeReader,
  encodedCWD,
} from "../../src/transcript/claudecode/claudecode.ts";
import { events } from "../../src/transcript/claudecode/parseClaude.ts";
import { tempDir } from "./tmp.ts";

test("encodedCWD", () => {
  expect(encodedCWD("/Users/olehluchkiv/Work/aether/harness-wrapper")).toBe(
    "-Users-olehluchkiv-Work-aether-harness-wrapper",
  );
});

test("encodedCWD non-alphanumeric", () => {
  const cases: [string, string][] = [
    ["/Users/oleh/.loom/WS/agent", "-Users-oleh--loom-WS-agent"],
    ["/a/b_c/d.e", "-a-b-c-d-e"],
    ["/with-dash/x", "-with-dash-x"],
    ["/p/v1.2.3", "-p-v1-2-3"],
  ];
  for (const [input, want] of cases) {
    expect(encodedCWD(input)).toBe(want);
  }
});

test("read against fixture", () => {
  const dir = tempDir();
  const cwd = "/some/work/dir";
  const projDir = path.join(dir, "projects", encodedCWD(cwd));
  mkdirSync(projDir, { recursive: true });
  const body = `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-05-14T12:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"text","text":"there"}]},"timestamp":"2026-05-14T12:00:05Z"}
{"type":"system"}
{"type":"attachment"}
`;
  writeFileSync(path.join(projDir, "sess-uuid.jsonl"), body);

  const evs = new ClaudeCodeReader(path.join(dir, "projects")).read(
    "sess-uuid",
    cwd,
  );
  expect(evs).toHaveLength(3);
  expect(evs[0].role).toBe("user");
  expect(evs[0].text).toBe("hello");
  expect(evs[1].role).toBe("assistant");
  expect(evs[1].text).toBe("hi");
  expect(evs[2].role).toBe("assistant");
  expect(evs[2].text).toBe("there");
});

test("resolves symlinked working dir", () => {
  const root = tempDir();
  const base = tempDir();
  const realWD = path.join(base, "realproj");
  mkdirSync(realWD, { recursive: true });
  const linkWD = path.join(base, "linkproj");
  symlinkSync(realWD, linkWD);

  const resolved = realpathSync(realWD);
  const projDir = path.join(root, encodedCWD(resolved));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    path.join(projDir, "sess.jsonl"),
    `{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-05-14T12:00:00Z"}
`,
  );

  const evs = new ClaudeCodeReader(root).read("sess", linkWD);
  expect(evs).toHaveLength(1);
  expect(evs[0].role).toBe("user");
  expect(evs[0].text).toBe("hello");
});

test("returns canonical events", () => {
  const dir = tempDir();
  const cwd = "/some/work/dir";
  const projDir = path.join(dir, "projects", encodedCWD(cwd));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    path.join(projDir, "sess.jsonl"),
    `{"type":"user","uuid":"u-1","message":{"role":"user","content":"hello"},"timestamp":"2026-05-14T12:00:00Z"}
`,
  );
  const evs = new ClaudeCodeReader(path.join(dir, "projects")).read(
    "sess",
    cwd,
  );
  expect(evs).toHaveLength(1);
  const e = evs[0];
  expect(e.type).toBe(EventText);
  expect(e.source).toBe(SourceFile);
  expect(e.uuid).toBe("u-1");
  expect(e.nativeID).toBeTruthy();
  expect(eventID(e)).toBe(e.nativeID!);
});

test("events tool-aware", () => {
  const body = `{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"running"},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]},"timestamp":"2026-05-14T12:00:00Z"}
{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":[{"type":"text","text":"file.go"}]}]},"timestamp":"2026-05-14T12:00:01Z"}
`;
  const evs = events(body);
  expect(evs).toHaveLength(3);
  expect(evs[1].type).toBe(EventToolUse);
  expect(evs[1].toolName).toBe("Bash");
  expect(evs[1].toolUseID).toBe("tu_1");
  expect(eventID(evs[1])).toBe("tool-use:tu_1");
  expect(evs[2].type).toBe(EventToolResult);
  expect(evs[2].toolUseID).toBe("tu_1");
  expect(evs[2].output).toBeTruthy();
  expect(eventID(evs[2])).toBe("tool-result:tu_1");
});

test("missing file errors", () => {
  expect(() =>
    new ClaudeCodeReader(tempDir()).read("missing", "/no/such/dir"),
  ).toThrow();
});
