import { expect, test, describe } from "vitest";

import {
  EventSessionMeta,
  EventText,
  RoleAssistant,
  RoleSystem,
  SourceHook,
} from "../../src/transcript/event.ts";
import { encodedCWD } from "../../src/transcript/claudecode/claudecode.ts";
import {
  ClaudeHookProvider,
  EventTurnBoundary,
  HookEventPostToolUse,
  HookEventSessionStart,
  HookEventStop,
  HookEventSubagentStop,
  claudeHookOwner,
  parseClaudeHookPayload,
  type ClaudeHookPayload,
} from "../../src/hooks/claude.ts";
import { guardPath, sessionMatches } from "../../src/hooks/guard.ts";
import { specFromProfile, type HookContext } from "../../src/hooks/provider.ts";

const HOME = "/home/u";
const CWD = "/work/proj";
const SID = "11111111-1111-1111-1111-111111111111";

function ctx(over: Partial<HookContext> = {}): HookContext {
  return {
    cwd: CWD,
    home: HOME,
    configDir: `${HOME}/.claude`,
    spoolDir: `${HOME}/.claude/spool`,
    harnessSessionID: SID,
    ...over,
  };
}

const projectDir = `${HOME}/.claude/projects/${encodedCWD(CWD)}`;
const okTranscript = `${projectDir}/${SID}.jsonl`;

describe("Claude payload parsing → SourceHook events", () => {
  test("SessionStart → session_meta marker", () => {
    const payload: ClaudeHookPayload = {
      session_id: SID,
      hook_event_name: HookEventSessionStart,
      source: "resume",
      cwd: CWD,
      transcript_path: okTranscript,
    };
    const out = parseClaudeHookPayload(payload, ctx());
    expect(out).toHaveLength(1);
    expect(out[0].harnessSessionID).toBe(SID);
    expect(out[0].event.type).toBe(EventSessionMeta);
    expect(out[0].event.role).toBe(RoleSystem);
    expect(out[0].event.source).toBe(SourceHook);
    expect(out[0].event.text).toBe("session-start:resume");
  });

  test("Stop → turn-boundary marker", () => {
    const out = parseClaudeHookPayload(
      {
        session_id: SID,
        hook_event_name: HookEventStop,
        stop_hook_active: true,
      },
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].event.type).toBe(EventTurnBoundary);
    expect(out[0].event.source).toBe(SourceHook);
    expect(out[0].event.text).toBe("turn-end");
  });

  test("SubagentStop → subagent turn-boundary marker", () => {
    const out = parseClaudeHookPayload(
      { session_id: SID, hook_event_name: HookEventSubagentStop },
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].event.type).toBe(EventTurnBoundary);
    expect(out[0].event.text).toBe("subagent-end");
    expect(out[0].event.source).toBe(SourceHook);
  });

  test("PostToolUse (PostTask) → boundary + provisional text", () => {
    const out = parseClaudeHookPayload(
      {
        session_id: SID,
        hook_event_name: HookEventPostToolUse,
        tool_name: "Task",
        tool_response: { content: "subagent said hello" },
      },
      ctx(),
    );
    expect(out).toHaveLength(2);
    expect(out[0].event.type).toBe(EventTurnBoundary);
    expect(out[0].event.text).toBe("post-task:Task");
    const text = out[1].event;
    expect(text.type).toBe(EventText);
    expect(text.role).toBe(RoleAssistant);
    expect(text.source).toBe(SourceHook);
    expect(text.text).toBe("subagent said hello");
    // Provisional: no file-identity nativeID.
    expect(text.nativeID).toBeUndefined();
  });

  test("PostToolUse with no response text → boundary only", () => {
    const out = parseClaudeHookPayload(
      {
        session_id: SID,
        hook_event_name: HookEventPostToolUse,
        tool_name: "Task",
      },
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].event.type).toBe(EventTurnBoundary);
  });

  test("accepts a JSON string payload", () => {
    const out = parseClaudeHookPayload(
      JSON.stringify({ session_id: SID, hook_event_name: HookEventStop }),
      ctx(),
    );
    expect(out).toHaveLength(1);
  });

  test("malformed JSON → dropped", () => {
    expect(parseClaudeHookPayload("{not json", ctx())).toEqual([]);
  });

  test("unrecognized hook event → dropped", () => {
    expect(
      parseClaudeHookPayload(
        { session_id: SID, hook_event_name: "PreToolUse" },
        ctx(),
      ),
    ).toEqual([]);
  });
});

describe("session-mismatch guard", () => {
  test("mismatched session id is dropped", () => {
    const out = parseClaudeHookPayload(
      {
        session_id: "deadbeef-0000-0000-0000-000000000000",
        hook_event_name: HookEventStop,
      },
      ctx(),
    );
    expect(out).toEqual([]);
  });

  test("matching session id passes", () => {
    const out = parseClaudeHookPayload(
      { session_id: SID, hook_event_name: HookEventStop },
      ctx(),
    );
    expect(out).toHaveLength(1);
  });

  test("empty expected id disarms the guard (any id passes)", () => {
    const out = parseClaudeHookPayload(
      { session_id: "whatever", hook_event_name: HookEventStop },
      ctx({ harnessSessionID: "" }),
    );
    expect(out).toHaveLength(1);
  });

  test("sessionMatches predicate", () => {
    expect(sessionMatches("a", "a")).toBe(true);
    expect(sessionMatches("a", "b")).toBe(false);
    expect(sessionMatches("", "b")).toBe(true);
    expect(sessionMatches(undefined, "b")).toBe(true);
  });
});

describe("path-traversal guard", () => {
  test("valid transcript path under the projects dir passes", () => {
    const out = parseClaudeHookPayload(
      {
        session_id: SID,
        hook_event_name: HookEventStop,
        cwd: CWD,
        transcript_path: okTranscript,
      },
      ctx(),
    );
    expect(out).toHaveLength(1);
  });

  test("traversal transcript path drops the whole payload", () => {
    const out = parseClaudeHookPayload(
      {
        session_id: SID,
        hook_event_name: HookEventStop,
        cwd: CWD,
        transcript_path: `${projectDir}/../../../../etc/passwd`,
      },
      ctx(),
    );
    expect(out).toEqual([]);
  });

  test("guardPath rejects relative escapes", () => {
    expect(guardPath("/base/dir", "../../etc/passwd")).toBeNull();
    expect(guardPath("/base/dir", "sub/../../../escape")).toBeNull();
  });

  test("guardPath rejects an absolute path outside the base", () => {
    expect(guardPath("/base/dir", "/etc/passwd")).toBeNull();
  });

  test("guardPath accepts an in-bounds path", () => {
    expect(guardPath("/base/dir", "child/file.txt")).toBe(
      "/base/dir/child/file.txt",
    );
    expect(guardPath("/base/dir", "/base/dir/child")).toBe("/base/dir/child");
  });

  test("guardPath rejects empty", () => {
    expect(guardPath("/base/dir", "")).toBeNull();
  });
});

describe("provider surface", () => {
  test("ensureConfig resolves a HookSpec at settings.json", () => {
    const spec = new ClaudeHookProvider().ensureConfig(ctx());
    expect(spec.configPath).toBe(`${HOME}/.claude/settings.json`);
    expect(spec.owner).toBe(claudeHookOwner);
    expect(spec.events.length).toBeGreaterThan(0);
    expect(spec.yield).toBeDefined();
    expect(spec.events.some((e) => e.event === HookEventSessionStart)).toBe(
      true,
    );
  });

  test("provider parsePayload delegates to parseClaudeHookPayload", () => {
    const out = new ClaudeHookProvider().parsePayload(
      JSON.stringify({ session_id: SID, hook_event_name: HookEventStop }),
      ctx(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].event.source).toBe(SourceHook);
  });

  test("specFromProfile copies entries and preserves owner/yield", () => {
    const spec = specFromProfile(
      {
        owner: "x",
        entries: [{ event: "Stop", command: "c" }],
        yield: { event: "Stop", command: "c" },
      },
      "/cfg/settings.json",
    );
    expect(spec.configPath).toBe("/cfg/settings.json");
    expect(spec.owner).toBe("x");
    expect(spec.events).toHaveLength(1);
    expect(spec.yield?.event).toBe("Stop");
  });
});
