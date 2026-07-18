// Port of pkg/chat/quiescence_test.go — claude-code marker-defer + settled-only
// completion + fallback prompt-readiness guard.
import { describe, expect, test } from "vitest";
import { Conversation, EventBus, Signal } from "../../src/chat/conversation.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import { newScreen } from "../../src/screen/index.ts";
import { claudecode, TurnComplete } from "../../src/turns/index.ts";
import {
  RoleAssistant,
  TurnStateStreaming,
  TurnStateComplete,
  TurnStateErrored,
  type Session,
  type Turn,
} from "../../src/chat/types.ts";

async function quiesceConv(
  frame: string,
  startedAgoMs: number,
): Promise<Conversation> {
  const store = newMemStore();
  const sess: Session = {
    id: "quiesce-session",
    harness: "",
    workingDir: "",
    createdAt: new Date(),
    harnessSessionID: "",
  };
  await store.createSession(sess);
  const turn: Turn = {
    id: "turn-1",
    sessionID: sess.id,
    role: RoleAssistant,
    state: TurnStateStreaming,
    text: "",
    reason: "",
    startedAt: new Date(Date.now() - startedAgoMs),
    completedAt: new Date(0),
    httpCode: 0,
    retryAfter: 0,
  };
  await store.appendTurn(turn);
  const sc = newScreen(120, 40);
  await sc.write(frame);
  return new Conversation({
    opts: { harness: "claude-code" },
    store,
    adapter: claudecode.New(),
    screen: sc,
    eventCh: new EventBus(4),
    markerArmCh: new Signal(),
    currentTurn: turn,
  });
}

function completed(c: Conversation): { value?: { turn?: Turn }; ok: boolean } {
  return c.eventCh.tryReceive();
}

describe("quiescence", () => {
  test("marker defers instead of instant-complete", async () => {
    const c = await quiesceConv(
      "✻ Pondered for 3s\n✶ Cerebrating… (57s · ↓ 4.8k tokens)\n❯ ",
      5000,
    );
    await c.handleTurnsEvent({
      kind: TurnComplete,
      at: new Date(),
      reason: "claude-code: ✻ Pondered for 3s",
    });
    expect(completed(c).ok).toBe(false);
    expect(c.currentTurn).not.toBeNull();
    expect(c.endMarkerSeen).toBe(true);
    expect(c.markerArmCh.tryReceive()).toBe(true);
  });

  test("completes only when settled (not while busy)", async () => {
    const working = await quiesceConv(
      "✶ Cerebrating… (57s · ↓ 4.8k tokens)\n  ◯ Explore  verify   24s · ↓ 35.8k tokens\n❯ ",
      5000,
    );
    working.endMarkerSeen = true;
    await working.maybeIdleComplete();
    expect(completed(working).ok).toBe(false);

    const settled = await quiesceConv(
      "⏺ Here is the revised plan.\n✻ Synthesized for 2m 3s\n❯ \n⏵⏵ auto mode on · ← for agents",
      5000,
    );
    settled.endMarkerSeen = true;
    await settled.maybeIdleComplete();
    const { value, ok } = completed(settled);
    expect(ok).toBe(true);
    expect(value!.turn!.state).toBe(TurnStateComplete);
    expect(value!.turn!.reason).toContain("marker confirmed");
  });

  test("fallback still requires readyForInput", async () => {
    const c = await quiesceConv("⏺ some output\n✻ Mused for 4s\n", 10000);
    await c.maybeIdleComplete(); // endMarkerSeen false → fallback
    expect(completed(c).ok).toBe(false);
  });

  // META-HARNESS-24: a ready, settled screen with NO assistant output — no "⏺"
  // bullet, no thinking marker — means the prompt was never accepted. The idle
  // fallback must error the turn, not complete it with the raw ready screen.
  test("fallback errors on a swallowed prompt (ready screen, no output)", async () => {
    const c = await quiesceConv("Claude Code\n\n❯ \n", 10000);
    await c.maybeIdleComplete(); // endMarkerSeen false → fallback
    const { value, ok } = completed(c);
    expect(ok).toBe(true);
    expect(value!.turn!.state).toBe(TurnStateErrored);
    expect(value!.turn!.reason).toContain("prompt not accepted");
    expect(value!.turn!.text).toBe("");
  });
});
