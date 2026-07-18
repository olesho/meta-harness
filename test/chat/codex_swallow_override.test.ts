// META-HARNESS-28 regression: on the idle-completion fallback, the screen-only
// swallowed-prompt heuristic false-fires when the codex TUI repaint lags the
// idle gap — a turn that fully succeeded (prompt accepted, reply in the on-disk
// rollout) was reported TurnStateErrored. The chat layer now consults the
// rollout before erroring: positive proof (the submitted prompt at/after the
// pre-send watermark, followed by assistant output) completes the turn with the
// clean transcript reply; anything less keeps the errored verdict.

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "../../src/internal/async/index.ts";
import {
  TurnStateComplete,
  TurnStateErrored,
  type Conversation,
} from "../../src/chat/index.ts";
import { codex } from "../../src/turns/index.ts";
import {
  New,
  openFake,
  sendOneTurn,
  waitForTerminalTurn,
  SubmitCSI13u,
  type Script,
} from "./fakeharness.ts";
import { writeCodexRollout } from "./helpers.ts";

// The Builder's default session UUID, emitted in every resume hint it paints.
const uuid = "11111111-2222-3333-4444-555555555555";

const open = new Set<Conversation>();
const tmps: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "codex-swallow-override-"));
  tmps.push(d);
  return d;
}

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The ticket's screen shape: submit consumed as a paste, prompt left sitting in
// the composer, screen otherwise settled. The first AwaitSubmit absorbs the
// startup /status prime; the resume hint in Idle makes the session id known at
// send time (so the pre-send watermark path is exercised).
function swallowedScript(): Script {
  return New("codex")
    .Idle()
    .AwaitSubmit() // the session-id primer's "/status" + CSI 13 u
    .Idle()
    .AwaitSubmit() // the real send
    .CodexSwallowed(0)
    .StayAliveUntilStopped()
    .Build();
}

async function openCodex(sessionsRoot: string): Promise<Conversation> {
  const conv = await openFake(swallowedScript());
  open.add(conv);
  (conv.getAdapter() as codex.CodexAdapter).sessionsRoot = sessionsRoot;
  return conv;
}

// The extended terminal-turn bound (8000, not 4000) covers the override's
// one-shot ~500ms flush-lag retry on the no-proof paths.
const waitBound = 8000;

describe("codex transcript-backed swallow override (real pty + fake harness)", () => {
  // 1. The ticket's shape: swallowed-looking screen, but codex accepted the
  // prompt and wrote the rollout (lazily, after the send). The turn must
  // complete with the clean transcript reply, never the raw ready screen.
  test("complete rollout overrides the false swallow verdict", async () => {
    const sessionsRoot = tempDir();
    const conv = await openCodex(sessionsRoot);
    const prompt =
      "Reply with exactly this token and nothing else: CX-DUMP-7007";
    await sendOneTurn(conv, prompt);
    writeCodexRollout(sessionsRoot, uuid, "", [
      {
        role: "user",
        text: "<environment_context>cwd: /tmp/x</environment_context>",
      },
      { role: "user", text: prompt },
      { role: "assistant", text: "CX-DUMP-7007" },
    ]);

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toBe("CX-DUMP-7007");
    expect(turn.reason).toContain("transcript-confirmed");
  });

  // 2. A rollout holding only PRIOR history (different prompt) is not proof of
  // the current turn.
  test("historical-only transcript still errors", async () => {
    const sessionsRoot = tempDir();
    writeCodexRollout(sessionsRoot, uuid, "", [
      { role: "user", text: "an earlier, different prompt" },
      { role: "assistant", text: "an earlier reply" },
    ]);
    const conv = await openCodex(sessionsRoot);
    await sendOneTurn(conv, "reply with just: ok");

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toContain("prompt not accepted");
    expect(turn.text).toBe("");
  });

  // 3. Watermark pin: a pre-existing rollout containing the IDENTICAL prompt +
  // reply (a resumed session re-asking the same thing) must not count — only a
  // match at/after the pre-send transcript length is proof of THIS turn.
  test("historical duplicate of the same prompt still errors", async () => {
    const sessionsRoot = tempDir();
    const prompt = "reply with just: ok";
    writeCodexRollout(sessionsRoot, uuid, "", [
      { role: "user", text: prompt },
      { role: "assistant", text: "ok" },
    ]);
    const conv = await openCodex(sessionsRoot);
    await sendOneTurn(conv, prompt);

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toContain("prompt not accepted");
    expect(turn.text).toBe("");
  });

  // 4a. Prompt accepted but no assistant output — not proof.
  test("prompt accepted but no assistant output still errors", async () => {
    const sessionsRoot = tempDir();
    const conv = await openCodex(sessionsRoot);
    const prompt = "reply with just: ok";
    await sendOneTurn(conv, prompt);
    writeCodexRollout(sessionsRoot, uuid, "", [{ role: "user", text: prompt }]);

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toContain("prompt not accepted");
  });

  // 4b. Reply collection stops at the next RoleUser turn: assistant output
  // belonging to a LATER user turn is not proof of this one.
  test("assistant output after a later user turn is not proof", async () => {
    const sessionsRoot = tempDir();
    const conv = await openCodex(sessionsRoot);
    const prompt = "reply with just: ok";
    await sendOneTurn(conv, prompt);
    writeCodexRollout(sessionsRoot, uuid, "", [
      { role: "user", text: prompt },
      { role: "user", text: "a later prompt" },
      { role: "assistant", text: "a later reply" },
    ]);

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toContain("prompt not accepted");
  });

  // 5a. A non-sentinel reader failure is never success — errored, with the
  // failure surfaced as a diagnostic suffix.
  test("reader failure is not success", async () => {
    const sessionsRoot = tempDir();
    const conv = await openCodex(sessionsRoot);
    await sendOneTurn(conv, "reply with just: ok");
    (conv.getAdapter() as codex.CodexAdapter).readTranscript = () => {
      throw new Error("disk exploded");
    };

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toContain("prompt not accepted");
    expect(turn.reason).toContain("transcript check failed");
  });

  // 5b. When the id was known pre-send but the pre-send read failed
  // non-sentinel, the watermark is "unknown" and the proof declines with the
  // watermark diagnostic instead of guessing a lower bound.
  test("unavailable pre-send watermark declines with its diagnostic", async () => {
    const sessionsRoot = tempDir();
    const conv = await openCodex(sessionsRoot);
    (conv.getAdapter() as codex.CodexAdapter).readTranscript = () => {
      throw new Error("disk exploded");
    };
    await sendOneTurn(conv, "reply with just: ok");

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toContain("pre-send transcript watermark unavailable");
  });

  // 6. Session-id ordering: the id is extractable ONLY from the settled
  // swallowed screen (no resume hint before it), so the branch must extract
  // the id BEFORE running the transcript proof.
  test("id visible only on the swallowed screen still overrides", async () => {
    const sessionsRoot = tempDir();
    const submitRE = SubmitCSI13u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const script: Script = {
      harness: "codex",
      steps: [
        { frame: { delay_ms: 0, screen: "Codex\n\n› \n" } },
        {
          wait_input: { until_regex: submitRE, capture: true, label: "submit" },
        }, // the send
        {
          frame: {
            delay_ms: 0,
            screen: "Codex\n\n› {{prompt}}\n\n  codex resume " + uuid + "\n",
            echo: true,
          },
        },
        { hold: {} },
      ],
    };
    // cols 55 < CODEX_STATUS_MIN_COLS suppresses the startup /status prime (its
    // halfway resend would otherwise race the script's submit waits), keeping
    // the session id genuinely unknown until the swallowed frame renders its
    // resume hint — which still fits unwrapped at this width.
    const conv = await openFake(script, { cols: 55 });
    open.add(conv);
    (conv.getAdapter() as codex.CodexAdapter).sessionsRoot = sessionsRoot;

    const prompt = "reply with just: ok";
    await sendOneTurn(conv, prompt);
    expect(conv.session.harnessSessionID).toBe(""); // genuinely unknown at send
    writeCodexRollout(sessionsRoot, uuid, "", [
      { role: "user", text: prompt },
      { role: "assistant", text: "ok" },
    ]);

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toBe("ok");
    expect(turn.reason).toContain("transcript-confirmed");
  });

  // 7. Gate pin: claude-code's swallow verdict is extraction-backed and must
  // never be transcript-second-guessed — its reader is not even consulted.
  test("claude-code swallow verdict is never transcript-overridden", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Idle() // the swallow: repaint the untouched ready screen
      .StayAliveUntilStopped()
      .Build();
    const conv = await openFake(script);
    open.add(conv);
    let readerCalled = false;
    (
      conv.getAdapter() as unknown as { readTranscript: () => unknown }
    ).readTranscript = () => {
      readerCalled = true;
      return [];
    };
    await sendOneTurn(conv, "This prompt will be swallowed");

    const turn = await waitForTerminalTurn(conv, 4000);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toContain("prompt not accepted");
    expect(turn.text).toBe("");
    expect(readerCalled).toBe(false);
  });

  // 8. Normalization: a prompt wrapped in an IDE context tag matches the
  // rollout's stripped user text — both sides go through stripIDEContextTags.
  test("ide-context-tagged prompt matches the stripped rollout text", async () => {
    const sessionsRoot = tempDir();
    const conv = await openCodex(sessionsRoot);
    const inner = "reply with just: ok";
    await sendOneTurn(
      conv,
      "<ide_selection>src/app.ts:10</ide_selection>" + inner,
    );
    writeCodexRollout(sessionsRoot, uuid, "", [
      { role: "user", text: inner }, // codex stores the stripped prompt text
      { role: "assistant", text: "ok" },
    ]);

    const turn = await waitForTerminalTurn(conv, waitBound);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toBe("ok");
    expect(turn.reason).toContain("transcript-confirmed");
  });
});
