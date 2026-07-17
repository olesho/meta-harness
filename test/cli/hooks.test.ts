import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  EventSessionMeta,
  SourceHook,
} from "../../src/transcript/event.ts"
import { encodedCWD } from "../../src/transcript/claudecode/claudecode.ts"
import { drainSpool } from "../../src/hooks/spool.ts"
import {
  EnvConfigDir,
  EnvSessionID,
  handleHookEvent,
  type Env,
} from "../../src/cli/hooks.ts"
import { EnvHome, EnvHookCwd, EnvSpool } from "../../src/acquisition/internal/yield.ts"
import {
  HookEventSessionStart,
  HookEventStop,
  type ClaudeHookPayload,
} from "../../src/hooks/claude.ts"

const HOME = "/home/u"
const CWD = "/work/proj"
const SID = "11111111-1111-1111-1111-111111111111"

const dirs: string[] = []
function freshSpool(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mh-cli-spool-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function env(spoolDir: string, over: Env = {}): Env {
  return {
    [EnvSpool]: spoolDir,
    [EnvHome]: HOME,
    [EnvHookCwd]: CWD,
    [EnvConfigDir]: `${HOME}/.claude`,
    [EnvSessionID]: SID,
    ...over,
  }
}

const okTranscript = `${HOME}/.claude/projects/${encodedCWD(CWD)}/${SID}.jsonl`

describe("handleHookEvent", () => {
  test("parses a Claude payload and spools canonical SourceHook events", () => {
    const spool = freshSpool()
    const payload: ClaudeHookPayload = {
      session_id: SID,
      hook_event_name: HookEventSessionStart,
      source: "startup",
      cwd: CWD,
      transcript_path: okTranscript,
    }

    const n = handleHookEvent("claude", "", env(spool), JSON.stringify(payload))
    expect(n).toBe(1)

    const drained = drainSpool(spool)
    expect(drained).toHaveLength(1)
    expect(drained[0].event.source).toBe(SourceHook)
    expect(drained[0].event.type).toBe(EventSessionMeta)
    expect(drained[0].harnessSessionID).toBe(SID)
  })

  test("injects the event-name CLI arg when the payload omits hook_event_name", () => {
    const spool = freshSpool()
    // Payload with NO hook_event_name — the event name comes from the arg.
    const payload = {
      session_id: SID,
      cwd: CWD,
      transcript_path: okTranscript,
    }
    const n = handleHookEvent("claude", HookEventStop, env(spool), JSON.stringify(payload))
    expect(n).toBe(1)
    const [d] = drainSpool(spool)
    expect(d.event.text).toBe("turn-end")
  })

  test("inert when the spool dir is unset — nothing spooled", () => {
    const spool = freshSpool()
    const payload: ClaudeHookPayload = {
      session_id: SID,
      hook_event_name: HookEventStop,
      cwd: CWD,
      transcript_path: okTranscript,
    }
    const n = handleHookEvent("claude", "", env(spool, { [EnvSpool]: "" }), JSON.stringify(payload))
    expect(n).toBe(0)
    expect(drainSpool(spool)).toHaveLength(0)
  })

  test("unknown harness spools nothing", () => {
    const spool = freshSpool()
    const n = handleHookEvent("nonexistent", HookEventStop, env(spool), "{}")
    expect(n).toBe(0)
    expect(drainSpool(spool)).toHaveLength(0)
  })

  test("a session-mismatched payload is dropped by the guard (nothing spooled)", () => {
    const spool = freshSpool()
    const payload: ClaudeHookPayload = {
      session_id: "22222222-2222-2222-2222-222222222222",
      hook_event_name: HookEventStop,
      cwd: CWD,
    }
    const n = handleHookEvent("claude", "", env(spool), JSON.stringify(payload))
    expect(n).toBe(0)
    expect(drainSpool(spool)).toHaveLength(0)
  })

  test("garbage stdin is dropped without throwing", () => {
    const spool = freshSpool()
    expect(() => handleHookEvent("claude", "", env(spool), "not json at all")).not.toThrow()
    expect(drainSpool(spool)).toHaveLength(0)
  })
})
