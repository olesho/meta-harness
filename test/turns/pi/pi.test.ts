// Port of pkg/turns/harness/pi/pi_test.go.

import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newScreen } from "../../../src/screen/index.ts";
import type { Snapshot } from "../../../src/screen/index.ts";
import * as pi from "../../../src/turns/harness/pi.ts";
import { slugForCwd } from "../../../src/transcript/pi/pi.ts";
import { TurnComplete } from "../../../src/turns/index.ts";
import { StatusWaitingForInput } from "../../../src/turns/index.ts";

async function snap(text: string): Promise<Snapshot> {
  const scr = newScreen(120, 40);
  await scr.write(text);
  return scr.snapshot();
}

// Frames captured live from pi 0.76.0 (cerebras/gpt-oss-120b).
const piBusyFrame =
  " ⠧ Working...\n────────────\n~/proj (main)\n0.0%/131k (auto)        gpt-oss-120b • medium\n";
const piThinkFrame =
  " ⠇ Thinking...\n────────────\n0.0%/131k (auto)        gpt-oss-120b • medium\n";
const piIdleFrame =
  "────────────\n~/proj (main)\n↑1.2k ↓32 $0.000 0.9%/131k (auto)        gpt-oss-120b • medium\n";
const piStartupFrame =
  " pi v0.76.0\n Press ctrl+o to show full startup help and loaded resources.\n ripgrep not found. Downloading...\n";
const piMenuFrame = " Thinking Level\n 1. off  2. low  3. medium\n";

describe("pi adapter", () => {
  test("name", () => {
    expect(pi.New().name()).toBe("pi");
  });

  test("no screen events by default", async () => {
    const scr = newScreen(120, 40);
    await scr.write("any old content\r\n");
    expect(pi.New().onScreen(scr.snapshot()).length).toBe(0);
  });

  test("fires on waiting_for_input", () => {
    const evs = pi
      .New()
      .onWrapperStatus(StatusWaitingForInput, "prompt detected: (y/n)");
    expect(evs.length).toBe(1);
    expect(evs[0].kind).toBe(TurnComplete);
  });

  test("capabilities", () => {
    const a = pi.New();
    expect(typeof (a as { readTranscript?: unknown }).readTranscript).toBe(
      "function",
    );
    expect(typeof (a as { quitSequence?: unknown }).quitSequence).toBe(
      "function",
    );
    expect(typeof (a as { busy?: unknown }).busy).toBe("function");
    expect(
      typeof (a as { extractSessionID?: unknown }).extractSessionID,
    ).not.toBe("function");
  });

  test("Busy", async () => {
    const a = pi.New();
    const cases: { name: string; text: string; want: boolean }[] = [
      { name: "working spinner", text: piBusyFrame, want: true },
      { name: "thinking spinner", text: piThinkFrame, want: true },
      { name: "idle status line", text: piIdleFrame, want: false },
      {
        name: "thinking-level menu is not busy",
        text: piMenuFrame,
        want: false,
      },
    ];
    for (const tc of cases) {
      expect(a.busy(await snap(tc.text))).toBe(tc.want);
    }
  });

  test("PromptReady", () => {
    const cases: { name: string; text: string; want: boolean }[] = [
      { name: "idle composer is ready", text: piIdleFrame, want: true },
      { name: "busy is not ready", text: piBusyFrame, want: false },
      { name: "thinking is not ready", text: piThinkFrame, want: false },
      { name: "startup is not ready", text: piStartupFrame, want: false },
    ];
    for (const tc of cases) {
      expect(pi.PromptReady(tc.text)).toBe(tc.want);
    }
  });

  test("QuitSequence", () => {
    expect(new TextDecoder().decode(pi.New().quitSequence())).toBe("/quit\r");
  });

  const uuidRE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("initSession mints --session-id <uuid>", () => {
    const [argv, id] = pi.New().initSession();
    expect(argv[0]).toBe("--session-id");
    expect(argv[1]).toBe(id);
    expect(id).toMatch(uuidRE);
  });

  test("resumeArgs", () => {
    const id = "0281fd4a-0a10-4dfe-adca-9b61b3777255";
    expect(pi.New().resumeArgs(id)).toEqual(["--session", id]);
  });

  test("readTranscript reads a fixture and forwards missing timestamp", () => {
    const sessionUUID = "0281fd4a-0a10-4dfe-adca-9b61b3777255";
    const workingDir = "/work/proj";
    const root = mkdtempSync(path.join(tmpdir(), "pi-turns-"));
    const sessDir = path.join(root, "sessions", slugForCwd(workingDir));
    mkdirSync(sessDir, { recursive: true });
    // Second message line carries no timestamp field.
    const body = `{"type":"session","version":3,"id":"${sessionUUID}","timestamp":"2024-12-03T14:00:00.000Z","cwd":"${workingDir}"}
{"type":"message","id":"a","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"hi"}}
{"type":"message","id":"b","message":{"role":"assistant","content":"yo"}}
`;
    writeFileSync(
      path.join(sessDir, "20241203T140000_" + sessionUUID + ".jsonl"),
      body,
    );
    const a = pi.New();
    a.root = root;
    const turns = a.readTranscript(sessionUUID, workingDir);
    expect(turns).toHaveLength(2);
    expect(turns[0].timestamp).toBeInstanceOf(Date);
    expect(turns[1].timestamp).toBeUndefined();
  });
});
