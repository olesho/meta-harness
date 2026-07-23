// refreshPermissionMode over a REAL pty (META-HARNESS-118): the post-Open
// `/status` probe, the write-back the pure GET route reads, and the two hazards
// a SECOND `/status` writer creates for the turn machinery.
//
// The deterministic, screen-painted half of this method's coverage (byte counts,
// the halfway resend, the deadlock carve-out, the gates) lives in
// test/chat/set_permission_mode.test.ts. What can only be shown end to end is
// here: that the bytes reach a real harness process, that the box parses back,
// and that a turn taken AFTER a probe still persists the reply the fake painted.

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HistorySourceTranscript,
  RoleAssistant,
  RoleUser,
  type Conversation,
  type Session,
} from "../../src/chat/index.ts";
import { Conversation as ConversationClass } from "../../src/chat/conversation.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import { permissionModeResponse } from "../../src/gateway/dto.ts";
import { Context } from "../../src/internal/async/index.ts";
import { newScreen } from "../../src/screen/index.ts";
import { codex } from "../../src/turns/index.ts";
import {
  New,
  openFake,
  sendOneTurn,
  waitForTerminalTurn,
} from "./fakeharness.ts";
import { writeCodexRollout } from "./helpers.ts";

const open = new Set<Conversation>();
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

const tmps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "refresh-permmode-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Runs `fn` holding the control token, the way an HTTP caller's request does. */
async function underToken<T>(
  conv: Conversation,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await conv.acquireControl(Context.background());
  try {
    return await fn();
  } finally {
    release();
  }
}

const uuid = "11111111-2222-3333-4444-555555555555";

describe("refreshPermissionMode over a pty", () => {
  // The KNOWN HOLE permissionMode()'s own docstring records: a resumed codex
  // session never renders a `/status` box at all (the prime is gated on
  // !opts.resume), so its reading is permanently `not_primed` — until this.
  test("a resumed codex session: not_primed -> the refreshed box, and GET agrees", async () => {
    const script = New("codex")
      .Session(uuid)
      .Idle()
      .AwaitSubmit()
      .CodexStatus(0, "Plan")
      .StayAliveUntilStopped()
      .Build();

    const conv = await openFake(script, { resume: uuid });
    open.add(conv);

    const before = conv.permissionMode();
    expect(before.source).toBe("not_primed");
    expect(before.collaboration).toBe("unknown");
    expect(before.observed).toBe("unknown");

    const got = await underToken(conv, () =>
      conv.refreshPermissionMode(Context.background()),
    );
    expect(got.source).toBe("status");
    expect(got.collaboration).toBe("plan");
    // The permissions axis comes from the same box, and is a LAUNCH fact: the
    // refresh reports it, it does not move it.
    expect(got.observed).toBe("acceptEdits");
    expect(got.generation).toBeGreaterThan(before.generation);

    // THE WRITE-BACK. permissionMode() is a pure read of the cache the probe
    // just wrote, and GET /v1/conversations/:id/permission-mode is a pure read
    // of permissionMode() — so the two routes cannot disagree.
    const snap = conv.screenSnapshot();
    const dto = permissionModeResponse(
      conv.permissionMode(snap),
      snap.generation,
    );
    expect(dto.collaboration).toBe("plan");
    expect(dto.source).toBe("status");
    expect(dto.generation).toBe(got.generation);
  }, 20000);

  // THE REPLY-SCRAPE HAZARD, pinned rather than left to be discovered. Codex
  // implements no extractMessage, so assistantText() falls back to the WHOLE
  // screen — which is why a second post-Open `/status` writer needs this frozen.
  // The containment is structural: the `currentTurn === null` gate keeps a probe
  // out of an in-flight turn, and the driver invents NO screen-clearing
  // keystroke (no ESC, no Ctrl-L) to tidy the box away.
  test("refresh, then a full turn: the reply is persisted, the box repainted away", async () => {
    const script = New("codex")
      .Session(uuid)
      .Idle()
      .AwaitSubmit() // the startup primer's /status
      .CodexStatus(0, "Default")
      .AwaitSubmit() // refreshPermissionMode's /status
      .CodexStatus(0, "Plan")
      .AwaitSubmit() // the turn's prompt
      .CodexReply(0, "● the answer is 42")
      .StayAliveUntilStopped()
      .Build();

    const conv = await openFake(script);
    open.add(conv);

    const refreshed = await underToken(conv, () =>
      conv.refreshPermissionMode(Context.background()),
    );
    expect(refreshed.collaboration).toBe("plan");
    expect(conv.screenSnapshot().text).toContain("Collaboration mode:");

    await sendOneTurn(conv, "what is 6*7");
    const turn = await waitForTerminalTurn(conv, 15000);
    expect(turn.text).toContain("the answer is 42");
    // codex repaints in place, so by the time the turn settles the box has left
    // the viewport and cannot land in the whole-screen scrape. This assertion is
    // the FREEZE: if a future codex build stopped repainting, the box WOULD
    // appear here, and that is a finding, not a flake.
    expect(turn.text).not.toContain("Collaboration mode:");

    // The reading survives the box scrolling off — Snapshot is viewport-only, so
    // the cache is the only thing that can answer after a turn.
    expect(conv.permissionMode().collaboration).toBe("plan");
    expect(conv.permissionMode().source).toBe("status");
  }, 20000);
});

// The history() half of the same hazard, driven deterministically: codex has a
// readTranscript adapter and historyWithSource PREFERS the harness transcript,
// so a `/status` box on screen cannot reach transcript-sourced history at all.
// Only the screen-scraped FALLBACK could ever carry it.
describe("a /status box on screen does not reach transcript history", () => {
  test("historyWithSource stays transcript-sourced and box-free", async () => {
    const cwd = tempDir();
    const sessionsRoot = tempDir();
    const rolloutUUID = "019f4118-cdb9-7013-a43a-4eb1f65d94f1";
    writeCodexRollout(sessionsRoot, rolloutUUID, cwd);

    const adapter = codex.New();
    adapter.sessionsRoot = sessionsRoot;

    const store = newMemStore();
    const sess: Session = {
      id: "chat-refresh-codex",
      harness: "codex",
      workingDir: cwd,
      createdAt: new Date(),
      harnessSessionID: rolloutUUID,
    };
    await store.createSession(sess);

    const screen = newScreen(120, 40);
    const conv = new ConversationClass({
      opts: { harness: "codex", workingDir: cwd, cols: 120, rows: 40 },
      adapter,
      screen,
      store,
      session: { ...sess },
    });

    // A `/status` box left on screen by a probe, exactly as refreshPermissionMode
    // leaves one.
    await screen.write(
      "\x1b[2J\x1b[H" +
        [
          ">_ OpenAI Codex (v0.144.5)",
          "│  Permissions:          Workspace (Ask for approval)  │",
          "│  Collaboration mode:   Plan                          │",
          "› ",
          "",
        ].join("\r\n"),
    );

    const [turns, source] = await conv.historyWithSource();
    expect(source).toBe(HistorySourceTranscript);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      [RoleUser, "hello codex"],
      [RoleAssistant, "hi there"],
    ]);
    expect(turns.some((t) => t.text.includes("Collaboration mode:"))).toBe(
      false,
    );
  });
});
