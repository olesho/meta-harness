// Smoke test for the permission-cycle fake-harness scaffolding (META-HARNESS-116).
//
// This is the proof that the scenario steps the rest of META-HARNESS-106 stands
// on actually work over a REAL pty: the wrapper's Shift+Tab bytes reach the fake
// through readUntil, and each answering frame parses back through the production
// readers (src/chat/permission.ts for claude's footer and codex's /status box,
// src/turns/harness/claudecode.ts DetectInput for the bypass dialog).
//
// It deliberately drives the raw cycle key itself rather than a setPermissionMode
// driver — no such driver exists yet, and this subtask ships no src/ logic.

import { afterEach, describe, expect, test } from "vitest";

import type { Conversation } from "../../src/chat/index.ts";
import { Context } from "../../src/internal/async/index.ts";
import {
  ClaudeDefaultRung,
  New,
  PermissionCycleCSI,
  SubmitCSI13u,
  openFake,
} from "./fakeharness.ts";

const enc = new TextEncoder();
const open = new Set<Conversation>();

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

/** Writes raw keystrokes into the fake's pty, the way a driver would. */
function press(conv: Conversation, keys: string): void {
  const sess = conv.wrapper();
  if (!sess) throw new Error("conversation has no wrapper session");
  sess.writeStdin(enc.encode(keys));
}

/**
 * Polls `probe` until it returns a value, or fails after `timeoutMs`. The fake
 * paints in response to our keystrokes, so there is no event to await — the
 * screen generation ticks whenever the next frame lands.
 */
async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = probe();
    if (last !== undefined) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("fake-harness permission-cycle scaffolding", () => {
  test("claude: two Shift+Tab presses walk two rungs of footers", async () => {
    const script = New("claude-code")
      .PermissionFooter(0, ClaudeDefaultRung)
      .AwaitPermissionCycle()
      .PermissionFooter(0, "acceptEdits")
      .AwaitPermissionCycle()
      .PermissionFooter(0, "plan")
      .StayAliveUntilStopped()
      .Build();

    const conv = await openFake(script);
    open.add(conv);

    // The fresh-session rung: the ONLY footer without "(shift+tab to cycle)",
    // so this assertion is also the suffix-less-parse regression.
    const first = await until("the default footer", 5000, () => {
      const r = conv.permissionMode();
      return r.observed === "manual" ? r : undefined;
    });
    expect(first.source).toBe("footer");
    expect(first.raw).toBe("manual mode on");

    press(conv, PermissionCycleCSI);
    const second = await until("the acceptEdits footer", 5000, () => {
      const r = conv.permissionMode();
      return r.observed === "acceptEdits" ? r : undefined;
    });
    expect(second.source).toBe("footer");
    expect(second.raw).toBe("accept edits on");

    press(conv, PermissionCycleCSI);
    const third = await until("the plan footer", 5000, () => {
      const r = conv.permissionMode();
      return r.observed === "plan" ? r : undefined;
    });
    expect(third.source).toBe("footer");
    expect(third.raw).toBe("plan mode on");
  }, 20000);

  test("claude: the bypass dialog parks mid-ring as a pending trust_prompt", async () => {
    const script = New("claude-code")
      .PermissionFooter(0, ClaudeDefaultRung)
      .AwaitPermissionCycle()
      .BypassPrompt(0)
      .StayAliveUntilStopped()
      .Build();

    const conv = await openFake(script);
    open.add(conv);

    await until("the default footer", 5000, () =>
      conv.permissionMode().observed === "manual" ? true : undefined,
    );

    press(conv, PermissionCycleCSI);
    const req = await until("the bypass trust_prompt", 5000, () => {
      return conv.pendingInput() ?? undefined;
    });
    expect(req.kind).toBe("trust_prompt");
    expect(req.prompt).toBe("Bypass Permissions mode");
    expect(req.options?.map((o) => o.label)).toEqual([
      "No, exit",
      "Yes, I accept",
    ]);

    // The point of parking it here: the dialog paints NO rung footer, so a cycle
    // loop that only watched the footer would report a stall instead of noticing
    // a pending input request.
    expect(conv.permissionMode().source).toBe("no_footer");
  }, 20000);

  test("codex: two /status probes confirm the collaboration 2-cycle", async () => {
    const script = New("codex")
      .Idle()
      .AwaitSubmit()
      .CodexStatus(0, "Default")
      .AwaitPermissionCycle()
      .CodexStatus(0, "Plan")
      .StayAliveUntilStopped()
      .Build();

    const conv = await openFake(script);
    open.add(conv);

    // Probe 1. If the startup session-id primer already wrote its own /status,
    // this write simply lands in the next readUntil's accumulator, where it
    // cannot match the cycle key — either way the Default box is painted once.
    press(conv, "/status" + SubmitCSI13u);
    const first = await until("the Default /status box", 5000, () => {
      const r = conv.permissionMode();
      return r.collaboration === "default" ? r : undefined;
    });
    expect(first.source).toBe("status");

    // Press once, then probe again: the confirm path has to be deterministic in
    // BOTH directions of the measured Default ⇄ Plan 2-cycle.
    press(conv, PermissionCycleCSI);
    const second = await until("the Plan /status box", 5000, () => {
      const r = conv.permissionMode();
      return r.collaboration === "plan" ? r : undefined;
    });
    expect(second.source).toBe("status");

    // The box stayed unwrapped, so the row-anchored session scrape still reads.
    expect(conv.screenSnapshot().text).toContain(">_ OpenAI Codex (v");
    expect(conv.sessionID()).not.toBe("");
  }, 20000);
});
