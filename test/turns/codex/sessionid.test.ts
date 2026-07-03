// Port of pkg/turns/harness/codex/sessionid_test.go.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newScreen } from "../../../src/screen/index.ts"
import * as codex from "../../../src/turns/harness/codex.ts"

const tmpRoots: string[] = []
afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
})

describe("codex session id", () => {
  test("scrapes legacy resume hint", async () => {
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1"
    const scr = newScreen(120, 40)
    await scr.write(
      "\x1b[H\x1b[2JTo continue this session, run codex resume " + uuid + "\r\n",
    )
    const [id, ok] = codex.New().extractSessionID(scr.snapshot())
    expect(ok).toBe(true)
    expect(id).toBe(uuid)
  })

  test("gap on 0.142 screen (no resume hint)", async () => {
    const post0142 =
      "26. line twenty-six\r\n" +
      "… (earlier lines scrolled off) …\r\n" +
      "› Summarize recent commits\r\n" +
      "gpt-5.5 default · 1.2M tokens left\r\n"
    const scr = newScreen(120, 40)
    await scr.write("\x1b[H\x1b[2J" + post0142)
    const [, ok] = codex.New().extractSessionID(scr.snapshot())
    expect(ok).toBe(false)
  })

  test("adapter implements SessionIDLocator", () => {
    const a = codex.New()
    expect(typeof a.locateSessionID).toBe("function")
  })

  test("recovers session id from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-sessions-"))
    tmpRoots.push(root)
    const cwd = "/work/proj"
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1"

    const dir = join(root, "2026", "06", "26")
    mkdirSync(dir, { recursive: true })
    const body =
      `{"timestamp":"2026-06-26T05:25:23.303Z","type":"session_meta","payload":{"session_id":"${uuid}","cwd":"${cwd}","cli_version":"0.142.0"}}` +
      "\n"
    writeFileSync(join(dir, `rollout-2026-06-26T07-25-23-${uuid}.jsonl`), body)

    const a = codex.New()
    a.sessionsRoot = root // test seam: override default ~/.codex/sessions
    const [id, ok] = a.locateSessionID(cwd)
    expect(ok).toBe(true)
    expect(id).toBe(uuid)
  })

  test("readTranscript projects the on-disk log to turns", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-sessions-"))
    tmpRoots.push(root)
    const uuid = "019f0263-cdb9-7013-a43a-4eb1f65d94f1"

    const dir = join(root, "2026", "06", "26")
    mkdirSync(dir, { recursive: true })
    const body =
      `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}\n` +
      `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi there"}]}}\n`
    writeFileSync(join(dir, `rollout-2026-06-26T07-25-23-${uuid}.jsonl`), body)

    const a = codex.New()
    a.sessionsRoot = root // test seam: override default ~/.codex/sessions
    const turns = a.readTranscript(uuid, "/unused")
    expect(turns).toHaveLength(2)
    expect(turns[0]!.role).toBe("user")
    expect(turns[0]!.text).toBe("hello")
    expect(turns[1]!.role).toBe("assistant")
    expect(turns[1]!.text).toBe("hi there")
  })

  test("readTranscript throws for a missing session", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-sessions-"))
    tmpRoots.push(root)
    const a = codex.New()
    a.sessionsRoot = root
    expect(() => a.readTranscript("no-such-uuid", "/unused")).toThrow()
  })

  test("resumeArgs leads with the `resume <uuid>` subcommand", () => {
    const args = codex.New().resumeArgs("sess-uuid")
    expect(args).toEqual(["resume", "sess-uuid"])
  })
})
