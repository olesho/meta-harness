import { describe, expect, test } from "vitest";
import {
  EventText,
  EventToolResult,
  EventToolUse,
  RoleAssistant,
  RoleTool,
  SourceFile,
  SourceHook,
  SourceLive,
  eventID,
  mergeHookEvents,
  type Event,
  type ParsedEvent,
} from "../../src/transcript/index.ts";

// textNativeID mirrors parseClaude.ts's per-source-stable text identity. It is
// asserted here (not imported — it's a private parser helper) to freeze the fact
// that it embeds the literal SourceFile string, which is exactly why hook text
// cannot collapse against it.
function claudeTextNativeID(lineUUID: string, seq: number): string {
  return `${SourceFile}:text:${lineUUID}:${seq}`;
}

function pe(event: Event, harnessSessionID = "s1"): ParsedEvent {
  return { harnessSessionID, event };
}

describe("mergeHookEvents — tool events dedup cross-source", () => {
  test("SourceHook tool-use collapses against the later SourceFile tool-use", () => {
    const hook: Event = {
      seq: 0,
      role: RoleAssistant,
      type: EventToolUse,
      toolName: "Bash",
      toolUseID: "call-1",
      source: SourceHook,
      nativeID: "tool-use:call-1",
    };
    const file: Event = {
      seq: 4,
      role: RoleAssistant,
      type: EventToolUse,
      toolName: "Bash",
      toolUseID: "call-1",
      source: SourceFile,
      nativeID: "tool-use:call-1",
    };
    // Same source-independent id → same dedup key.
    expect(eventID(hook)).toBe(eventID(file));

    const merged = mergeHookEvents([pe(file)], [pe(hook)]);
    expect(merged).toHaveLength(1);
    // Authority resolves to the SourceFile event.
    expect(merged[0].event.source).toBe(SourceFile);
    expect(merged[0].event.seq).toBe(4);
  });

  test("SourceHook tool-result collapses against the SourceFile tool-result", () => {
    const hook: Event = {
      role: RoleTool,
      type: EventToolResult,
      toolUseID: "call-9",
      output: "provisional",
      source: SourceHook,
      nativeID: "tool-result:call-9",
    };
    const file: Event = {
      role: RoleTool,
      type: EventToolResult,
      toolUseID: "call-9",
      output: "authoritative",
      source: SourceFile,
      nativeID: "tool-result:call-9",
    };
    const merged = mergeHookEvents([pe(file)], [pe(hook)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].event.source).toBe(SourceFile);
    expect(merged[0].event.output).toBe("authoritative");
  });

  test("a hook-only tool event with no file counterpart is preserved", () => {
    const hook: Event = {
      type: EventToolUse,
      toolUseID: "call-solo",
      source: SourceHook,
      nativeID: "tool-use:call-solo",
    };
    const merged = mergeHookEvents([], [pe(hook)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].event.source).toBe(SourceHook);
  });
});

describe("mergeHookEvents — text is NOT file-identity deduped", () => {
  test("hook text stays SourceHook, SourceFile text is preserved, no dup synthesized", () => {
    const fileText: Event = {
      seq: 1,
      role: RoleAssistant,
      type: EventText,
      text: "hello world",
      uuid: "line-uuid",
      source: SourceFile,
      nativeID: claudeTextNativeID("line-uuid", 1),
    };
    // Hook text is provisional and tagged SourceHook. It cannot reproduce the
    // file's seq/lineUUID identity, so its eventID necessarily differs.
    const hookText: Event = {
      seq: 0,
      role: RoleAssistant,
      type: EventText,
      text: "hello world",
      source: SourceHook,
      nativeID: "hook:text:hello world",
    };
    expect(eventID(hookText)).not.toBe(eventID(fileText));

    const merged = mergeHookEvents([pe(fileText)], [pe(hookText)]);
    // Both survive: no file-identity dedup was attempted for text.
    expect(merged).toHaveLength(2);

    const bySource = merged.map((m) => m.event.source);
    expect(bySource).toContain(SourceHook);
    expect(bySource).toContain(SourceFile);

    // The authoritative SourceFile text event is preserved unchanged.
    const file = merged.find((m) => m.event.source === SourceFile)!;
    expect(file.event.nativeID).toBe(claudeTextNativeID("line-uuid", 1));

    // No competing SourceFile-identity text was synthesized: exactly one event
    // carries a SourceFile-identity text id.
    const fileIdentityTexts = merged.filter(
      (m) =>
        m.event.type === EventText &&
        m.event.nativeID?.startsWith(`${SourceFile}:text:`),
    );
    expect(fileIdentityTexts).toHaveLength(1);
  });

  test("textNativeID identity is unchanged (still embeds the SourceFile string)", () => {
    // Guards deliverable: textNativeID must stay source-DEPENDENT — making it
    // source-independent is explicitly rejected.
    expect(claudeTextNativeID("u", 3)).toBe("file:text:u:3");
    expect(claudeTextNativeID("u", 3).startsWith(`${SourceFile}:`)).toBe(true);
  });
});

describe("mergeHookEvents — provenance & ordering", () => {
  test("SourceLive is never produced; hook is the second emitted provenance after file", () => {
    // The consumer only ever emits events tagged as the reader/hook produced
    // them. Feeding it file + hook yields exactly {SourceFile, SourceHook} — and
    // never SourceLive, which no producer assigns.
    const file: Event = {
      seq: 1,
      type: EventToolUse,
      toolUseID: "a",
      source: SourceFile,
      nativeID: "tool-use:a",
    };
    const hook: Event = {
      seq: 2,
      type: EventToolUse,
      toolUseID: "b",
      source: SourceHook,
      nativeID: "tool-use:b",
    };
    const merged = mergeHookEvents([pe(file)], [pe(hook)]);
    const sources = new Set(merged.map((m) => m.event.source));
    expect(sources).toEqual(new Set([SourceFile, SourceHook]));
    expect(sources.has(SourceLive)).toBe(false);
  });

  test("merged set is ordered by seq then timestamp", () => {
    const t = (ms: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, ms));
    const file: Event = {
      seq: 5,
      type: EventToolUse,
      toolUseID: "late",
      timestamp: t(500),
      source: SourceFile,
      nativeID: "tool-use:late",
    };
    const hookEarly: Event = {
      seq: 1,
      type: EventToolUse,
      toolUseID: "early",
      timestamp: t(100),
      source: SourceHook,
      nativeID: "tool-use:early",
    };
    const hookMid: Event = {
      seq: 3,
      type: EventToolUse,
      toolUseID: "mid",
      timestamp: t(300),
      source: SourceHook,
      nativeID: "tool-use:mid",
    };
    const merged = mergeHookEvents([pe(file)], [pe(hookEarly), pe(hookMid)]);
    expect(merged.map((m) => m.event.seq)).toEqual([1, 3, 5]);
  });

  test("neither input array is mutated", () => {
    const existing = [
      pe({
        type: EventToolUse,
        toolUseID: "x",
        source: SourceFile,
        nativeID: "tool-use:x",
      }),
    ];
    const batch = [
      pe({
        type: EventToolUse,
        toolUseID: "x",
        source: SourceHook,
        nativeID: "tool-use:x",
      }),
    ];
    mergeHookEvents(existing, batch);
    expect(existing).toHaveLength(1);
    expect(batch).toHaveLength(1);
  });
});
