// Drives the shared one-shot loop (src/oneshot) over a REAL pty + fake harness:
// prompt in → clean reply out, one terminal turn, then teardown. Also asserts
// the deadline path throws DeadlineError and env-clean strips leaked vars.

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runOneShot,
  runOneShotDetailed,
  cleanEnv,
  isLeakedClaudeEnv,
  DeadlineError,
  TurnErroredError,
} from "../../src/oneshot/index.ts";
import { Context } from "../../src/internal/async/index.ts";
import { AutoAcceptTrust } from "../../src/oneshot/index.ts";
import * as claudecode from "../../src/turns/harness/claudecode.ts";
import { KeyRecorder, newTestConv } from "../chat/helpers.ts";
import {
  New,
  PromptRef,
  EnvVar,
  fakeHarnessBin,
  testIdleGap,
  testMarkerGap,
} from "../chat/fakeharness.ts";

function scriptEnv(
  script: ReturnType<ReturnType<typeof New>["Build"]>,
): string[] {
  const dir = mkdtempSync(join(tmpdir(), "oneshot-script-"));
  const scriptPath = join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script), { mode: 0o600 });
  return [
    ...Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`),
    `${EnvVar}=${scriptPath}`,
  ];
}

const cancels: (() => void)[] = [];
afterEach(() => {
  for (const c of cancels.splice(0)) c();
});

function deadline(ms: number): Context {
  const { ctx, cancel } = Context.withDeadline(Context.background(), ms);
  cancels.push(cancel);
  return ctx;
}

describe("runOneShot (real pty + fake harness)", () => {
  test("completes one turn and returns the clean reply with the prompt echoed", async () => {
    const sentinel = "ONESHOT-42";
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Reply(40, "Answer: " + PromptRef(), "Synthesized", "5s")
      .Build();

    const reply = await runOneShot(deadline(8000), {
      harness: "claude-code",
      binaryPath: fakeHarnessBin,
      prompt: "Reply with " + sentinel,
      env: scriptEnv(script),
      idleGap: testIdleGap,
      markerGap: testMarkerGap,
    });

    expect(reply).toContain(sentinel);
  });

  test("deadline fires DeadlineError when the turn never settles", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .StayAliveUntilStopped()
      .Build();

    await expect(
      runOneShot(deadline(400), {
        harness: "claude-code",
        binaryPath: fakeHarnessBin,
        prompt: "hang please",
        env: scriptEnv(script),
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      }),
    ).rejects.toBeInstanceOf(DeadlineError);
  });

  test("empty prompt is rejected before spawning", async () => {
    await expect(
      runOneShot(deadline(2000), {
        harness: "claude-code",
        binaryPath: fakeHarnessBin,
        prompt: "   \n",
      }),
    ).rejects.toThrow();
  });
});

describe("runOneShotDetailed (failure-safe result union)", () => {
  const SESSION_ID = "abcd1234-0000-0000-0000-000000000001";
  // claude-code mints its own session id at launch (--session-id <uuid>), so
  // the detailed result carries that minted uuid — not the fake's hint id.
  const uuidRE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test("completed: carries reply, harnessSessionID, and workingDir", async () => {
    const sentinel = "DETAILED-OK";
    const script = New("claude-code")
      .Session(SESSION_ID)
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Reply(40, "Answer: " + PromptRef(), "Synthesized", "5s")
      .Build();

    const wd = mkdtempSync(join(tmpdir(), "detailed-wd-"));
    const out = await runOneShotDetailed(deadline(8000), {
      harness: "claude-code",
      binaryPath: fakeHarnessBin,
      prompt: "Reply with " + sentinel,
      workingDir: wd,
      env: scriptEnv(script),
      idleGap: testIdleGap,
      markerGap: testMarkerGap,
    });

    expect(out.status).toBe("completed");
    if (out.status !== "completed") throw new Error("unreachable");
    expect(out.reply).toContain(sentinel);
    expect(out.harnessSessionID).toMatch(uuidRE);
    expect(out.harnessSessionID).not.toBe(SESSION_ID);
    expect(out.workingDir).toBe(wd);
  });

  test("empty prompt: startup_error, never throws", async () => {
    const out = await runOneShotDetailed(deadline(2000), {
      harness: "claude-code",
      binaryPath: fakeHarnessBin,
      prompt: "   \n",
      workingDir: "/tmp/empty-wd",
    });

    expect(out.status).toBe("startup_error");
    if (out.status !== "startup_error") throw new Error("unreachable");
    expect(out.reason).toContain("empty");
    expect(out.workingDir).toBe("/tmp/empty-wd");
  });

  test("deadline: reports 'deadline' and still carries the minted session id", async () => {
    const script = New("claude-code")
      .Session(SESSION_ID)
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .StayAliveUntilStopped()
      .Build();

    const out = await runOneShotDetailed(deadline(600), {
      harness: "claude-code",
      binaryPath: fakeHarnessBin,
      prompt: "hang please",
      env: scriptEnv(script),
      idleGap: testIdleGap,
      markerGap: testMarkerGap,
    });

    expect(out.status).toBe("deadline");
    if (out.status !== "deadline") throw new Error("unreachable");
    expect(out.harnessSessionID).toMatch(uuidRE);
  });
});

describe("cleanEnv", () => {
  test("strips CLAUDECODE and CLAUDE_CODE_* but keeps others", () => {
    const out = cleanEnv([
      "PATH=/bin",
      "CLAUDECODE=1",
      "CLAUDE_CODE_ENTRYPOINT=cli",
      "CLAUDE_CODE_SSE_PORT=1234",
      "HOME=/home/x",
      "CLAUDE_SOMETHING=keepme",
    ]);
    expect(out).toContain("PATH=/bin");
    expect(out).toContain("HOME=/home/x");
    expect(out).toContain("CLAUDE_SOMETHING=keepme");
    expect(out.some((e) => e.startsWith("CLAUDECODE"))).toBe(false);
    expect(out.some((e) => e.startsWith("CLAUDE_CODE_"))).toBe(false);
  });

  test("isLeakedClaudeEnv matches the scrub keys", () => {
    expect(isLeakedClaudeEnv("CLAUDECODE")).toBe(true);
    expect(isLeakedClaudeEnv("CLAUDE_CODE_ENTRYPOINT")).toBe(true);
    // Delegates to isClaudeNestingEnvKey, so the credential exemption holds here too.
    expect(isLeakedClaudeEnv("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    expect(isLeakedClaudeEnv("CLAUDE_SOMETHING")).toBe(false);
    expect(isLeakedClaudeEnv("PATH")).toBe(false);
  });
});

// Keep TurnErroredError referenced so the type import is exercised.
test("TurnErroredError carries the reason", () => {
  const e = new TurnErroredError("api blocked");
  expect(e.reason).toBe("api blocked");
  expect(e.message).toContain("api blocked");
});

// The unattended path that actually hangs in the fleet: an untrusted repo, no
// human, claude 2.1.251's UNNUMBERED trust dialog. AutoAcceptTrust needs no
// change of its own — findOption resolves "proceed" by ALIAS, which the selector
// parser populates — but the bytes it ends up writing are the whole point, so
// they are pinned here rather than assumed.
describe("AutoAcceptTrust against the unnumbered trust dialog", () => {
  // Captured live (tmux, 2026-08-29; see PUPPET-236). Highlight on "No, exit".
  const unnumberedTrustScreen =
    "Accessing workspace:\n" +
    "/private/tmp/trustrepo\n" +
    "Quick safety check: Is this a project you created or one you trust? …\n" +
    "Claude Code'll be able to read, edit, and execute files here.\n" +
    "Security guide\n" +
    " ❯ No, exit\n" +
    "   Yes, I trust this folder\n" +
    "Enter to confirm · Esc to cancel\n";

  test('resolves optionID "proceed" and writes ESC [ B + CR, not a bare CR', () => {
    const req = claudecode.DetectInput(unnumberedTrustScreen);
    expect(req).not.toBeNull();
    expect(req!.kind).toBe("trust_prompt");

    const rec = new KeyRecorder();
    const c = newTestConv(
      { harness: "claude-code", inputPolicy: AutoAcceptTrust },
      rec,
    );
    c.handleInputRequested(req!);

    // A bare CR here would confirm the highlighted row — "No, exit" — and quit
    // claude at startup.
    expect(rec.text()).not.toBe("\r");
    expect(rec.text()).toBe("\x1b[B\r");
    // Answered server-side: nothing surfaced to a client that is not there.
    expect(c.inputSurfaced).toBe(false);
  });
});
