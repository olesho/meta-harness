import { expect, test } from "vitest";
import {
  EventToolResult,
  EventToolUse,
  EventText,
  RoleAssistant,
  RoleTool,
  SchemaVersion,
  SourceFile,
  SourceLive,
  toPublicJSON,
  type ParsedEvent,
} from "../../src/transcript/event.ts";
import {
  marshalParsedEvents,
  unmarshalParsedEvents,
} from "../../src/transcript/eventWire.ts";

// The DURABLE codec must preserve the INTERNAL fields (source/nativeID/
// schemaVersion) that the public DTO omits.
test("parsed events durable round-trip preserves internal fields", () => {
  const input: ParsedEvent[] = [
    {
      harnessSessionID: "sess-1",
      event: {
        seq: 3,
        timestamp: new Date(1700000000000),
        role: RoleAssistant,
        type: EventToolUse,
        toolName: "Bash",
        toolUseID: "tu1",
        toolInput: `{"command":"ls"}`,
        source: SourceLive,
        nativeID: "tool-use:tu1",
        schemaVersion: SchemaVersion,
      },
    },
    {
      harnessSessionID: "sub-2",
      parentSessionID: "sess-1",
      event: {
        seq: 0,
        role: RoleTool,
        type: EventToolResult,
        output: "file.go",
        toolUseID: "tu1",
        source: SourceFile,
        nativeID: "tool-result:tu1",
        schemaVersion: SchemaVersion,
      },
    },
  ];

  const out = unmarshalParsedEvents(marshalParsedEvents(input));
  expect(out).toHaveLength(input.length);
  for (let i = 0; i < input.length; i++) {
    const a = input[i];
    const b = out[i];
    expect(b.harnessSessionID).toBe(a.harnessSessionID);
    expect(b.parentSessionID).toBe(a.parentSessionID);
    expect(b.event.source).toBe(a.event.source!);
    expect(b.event.nativeID).toBe(a.event.nativeID!);
    expect(b.event.schemaVersion).toBe(a.event.schemaVersion!);
    expect(b.event.type).toBe(a.event.type!);
    expect(b.event.toolUseID).toBe(a.event.toolUseID);
    expect(b.event.output ?? "").toBe(a.event.output ?? "");
    expect(b.event.toolInput ?? "").toBe(a.event.toolInput ?? "");
  }
});

// The public DTO must still omit the internal fields.
test("public event JSON omits internal fields", () => {
  const data = JSON.stringify(
    toPublicJSON({
      type: EventText,
      text: "hi",
      source: SourceLive,
      nativeID: "x",
      schemaVersion: 1,
    }),
  );
  for (const banned of [`"source"`, `"native_id"`, `"schema_version"`]) {
    expect(data.includes(banned)).toBe(false);
  }
});
