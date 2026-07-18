// Live end-to-end check against the INSTALLED claude binary — the durable
// guard against live stdin drift. The corpus replay tests only feed recorded
// output bytes into Screen; they can never notice the live binary rejecting
// our prompt/submit keystrokes. Opt-in and skipped by default:
//
//   LIVE_CLAUDE=1 bun test test/oneshot/live_claude.test.ts
//
// Two checks, both through public surfaces:
//   1. runOneShot() — the production one-shot path (src/oneshot/oneshot.ts):
//      prompt in → a real, non-empty reply out that is NOT the ready screen.
//   2. chat Open()/send()/quit() — the layer runOneShot wraps — additionally
//      asserting the child echoed the prompt into the rendered screen, that the
//      harness session id is pinned at launch (chat mints it and passes
//      `--session-id <uuid>`; 2.1.201 no longer prints the exit-time resume
//      hint), and that history() reads the on-disk transcript back under that
//      pinned id after the turn completes.

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EventTurn,
  Open,
  RoleAssistant,
  TurnStateComplete,
  TurnStateErrored,
  newMemStore,
  readyForInput,
  type Conversation,
  type Store,
  type Turn,
} from "../../src/chat/index.ts";
import { Context } from "../../src/internal/async/index.ts";
import { AutoAcceptTrust, runOneShot } from "../../src/oneshot/index.ts";

const live = process.env.LIVE_CLAUDE === "1";
const BIN = process.env.LIVE_CLAUDE_BIN ?? "claude";

// A prompt whose correct answer is trivially checkable and cannot be confused
// with the echoed prompt itself (the reply must not contain the full prompt —
// a "reply" that does is the ready screen leaking through).
const PROMPT = "Reply with exactly the single word: pomegranate";
const TOKEN = "pomegranate";

const TEST_TIMEOUT = 240_000;
const CTX_DEADLINE = TEST_TIMEOUT - 15_000;

const uuidRE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function liveCtx(): { ctx: Context; cancel: () => void } {
  return Context.withDeadline(Context.background(), CTX_DEADLINE);
}

/** Drains conversation events until the assistant turn reaches a terminal state. */
async function waitTerminal(ctx: Context, conv: Conversation): Promise<Turn> {
  const bus = conv.events();
  for (;;) {
    const outcome = await Promise.race([
      bus.receive(),
      ctx.done().then(() => "cancel" as const),
    ]);
    if (outcome === "cancel")
      throw ctx.err() ?? new Error("live: context done");
    const { value, ok } = outcome;
    if (!ok)
      throw new Error("live: event channel closed before a terminal turn");
    const ev = value!;
    if (
      ev.type === EventTurn &&
      ev.turn?.role === RoleAssistant &&
      (ev.turn.state === TurnStateComplete ||
        ev.turn.state === TurnStateErrored)
    ) {
      return ev.turn;
    }
  }
}

/** Polls the store until the session's harnessSessionID is set, or `boundMs` elapses. */
async function pollHarnessSessionID(
  store: Store,
  sessionID: string,
  boundMs: number,
): Promise<string> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    const sess = await store.getSession(sessionID);
    if (sess.harnessSessionID !== "") return sess.harnessSessionID;
    if (Date.now() >= deadline) return "";
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("live claude e2e (LIVE_CLAUDE=1)", () => {
  test.skipIf(!live)(
    "runOneShot submits the prompt and returns a real reply, not the ready screen",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "live-claude-oneshot-"));
      const { ctx, cancel } = liveCtx();
      try {
        const reply = await runOneShot(ctx, {
          harness: "claude-code",
          binaryPath: BIN,
          prompt: PROMPT,
          workingDir: dir,
        });
        // A real, non-empty assistant answer…
        expect(reply.trim()).not.toBe("");
        expect(reply.toLowerCase()).toContain(TOKEN);
        // …that is NOT the rendered ready screen: no composer, no echoed
        // prompt, and the readiness predicate must not recognize it.
        expect(reply).not.toContain("❯");
        expect(reply).not.toContain(PROMPT);
        expect(readyForInput("claude-code", reply)).toBe(false);
      } finally {
        cancel();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );

  test.skipIf(!live)(
    "live send echoes the prompt on screen, pins the session id at launch, and reads the transcript back",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "live-claude-chat-"));
      const store = newMemStore();
      const { ctx, cancel } = liveCtx();
      const conv = await Open(ctx, {
        harness: "claude-code",
        binaryPath: BIN,
        workingDir: dir,
        store,
        inputPolicy: AutoAcceptTrust,
      });
      try {
        // The id is minted by chat at Open (`--session-id <uuid>`) — available
        // immediately, without waiting for any exit-time hint (2.1.201 prints
        // none). pollHarnessSessionID returns instantly on the seeded id.
        const seededID = await pollHarnessSessionID(
          store,
          conv.sessionID(),
          5_000,
        );
        expect(seededID).toMatch(uuidRE);

        const release = await conv.acquireControl(ctx);
        try {
          await conv.send(ctx, PROMPT);
        } finally {
          release();
        }

        const turn = await waitTerminal(ctx, conv);
        expect(turn.state).toBe(TurnStateComplete);
        expect(turn.text.trim()).not.toBe("");
        expect(turn.text.toLowerCase()).toContain(TOKEN);

        // The child echoed the prompt: it must be visible in the captured screen.
        expect(conv.screenSnapshot().text).toContain(PROMPT);

        // The ticket's actual complaint: with the id pinned at launch, claude
        // persists its JSONL under exactly that uuid and history() reads the
        // transcript back — no more silent store-fallback with zero entries.
        // The transcript flush can lag turn completion; retry briefly.
        let transcript: Turn[] = [];
        const historyDeadline = Date.now() + 20_000;
        for (;;) {
          transcript = await conv.history();
          if (transcript.length > 0 || Date.now() >= historyDeadline) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(transcript.length).toBeGreaterThan(0);
        expect(
          transcript.some((t) => t.text.toLowerCase().includes(TOKEN)),
        ).toBe(true);

        // Graceful quit must not disturb the pinned id.
        await conv.quit(ctx);
        const harnessID = await pollHarnessSessionID(
          store,
          conv.sessionID(),
          5_000,
        );
        expect(harnessID).toBe(seededID);
      } finally {
        cancel();
        const { ctx: closeCtx } = Context.withDeadline(
          Context.background(),
          3000,
        );
        await conv.close(closeCtx).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT,
  );
});
