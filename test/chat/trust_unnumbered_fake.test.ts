// End-to-end proof over a REAL pty that claude 2.1.251's UNNUMBERED folder-trust
// dialog is answered with relative arrow motion (PUPPET-296).
//
// This is the single most valuable test in the set, and the one that fails if
// someone later "simplifies" the selector keys to a bare CR — which is precisely
// the change that would quit claude at startup, because the dialog's default
// highlight is on "No, exit".
//
// The fake blocks on `AwaitSelectorDown()`, whose until_regex is the literal
// `ESC [ B` + CR. It matches only if the production path writes those bytes; a
// bare CR, or the arrows split across writes, hangs the scenario and this test
// times out.

import { afterEach, describe, expect, test } from "vitest";

import { Context } from "../../src/internal/async/index.ts";
import {
  DispositionAnswer,
  TurnStateComplete,
  type Conversation,
} from "../../src/chat/index.ts";
import { AutoAcceptTrust } from "../../src/oneshot/index.ts";
import {
  New,
  openFake,
  sendOneTurn,
  waitForTerminalTurn,
} from "./fakeharness.ts";

const open = new Set<Conversation>();

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

/**
 * The scenario: claude paints the unnumbered trust dialog, blocks until the
 * wrapper writes Down+CR, then paints the trusted, idle composer and runs a
 * normal turn to completion.
 */
function trustScenario() {
  return New("claude-code")
    .TrustPromptUnnumbered(0)
    .AwaitSelectorDown()
    .Idle()
    .AwaitSubmit()
    .Working(30, "Thinking")
    .Reply(40, "TRUSTED", "Synthesized", "5s")
    .Build();
}

describe("unnumbered folder-trust dialog over a fake pty", () => {
  test("the trust_prompt policy answers proceed with ESC [ B + CR", async () => {
    const conv = await openFake(trustScenario(), {
      inputPolicy: {
        byKind: {
          trust_prompt: { kind: DispositionAnswer, optionID: "proceed" },
        },
      },
    });
    open.add(conv);

    // If the answer bytes were a bare CR (or split writes), the fake never
    // advances past AwaitSelectorDown and send() times out on the composer.
    await sendOneTurn(conv, "hello");
    const turn = await waitForTerminalTurn(conv, 10000);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain("TRUSTED");
  });

  // The unattended path — the one that actually hangs in the fleet. AutoAcceptTrust
  // is the one-shot loop's policy; it must resolve "proceed" against the
  // unnumbered option set with no change of its own.
  test("AutoAcceptTrust resolves proceed against the unnumbered options", async () => {
    const conv = await openFake(trustScenario(), {
      inputPolicy: AutoAcceptTrust,
    });
    open.add(conv);

    await sendOneTurn(conv, "hello");
    const turn = await waitForTerminalTurn(conv, 10000);
    expect(turn.state).toBe(TurnStateComplete);
    expect(turn.text).toContain("TRUSTED");
  });
});
