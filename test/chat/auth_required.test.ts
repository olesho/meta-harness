// A turn driven against a harness whose CLI is LOGGED OUT produces no assistant
// output — but the failure isn't the ticket's fault, it's a missing/expired
// login. The idle-completion fallback must error such a turn with the canonical,
// machine-matchable ReasonAuthRequired (so a consumer can say "renew the harness
// login") instead of the generic "prompt not accepted / no assistant output".
//
// These drive a REAL pty + the fake harness, mirroring swallowedprompt.test.ts,
// but the settled swallow screen carries a real observed logged-out banner:
//   - claude-code: "Not logged in · Please run /login"
//   - codex:       "401 Unauthorized: Missing bearer or basic authentication"

import { afterEach, describe, expect, test } from "vitest";

import { Context } from "../../src/internal/async/index.ts";
import {
  ReasonAuthRequired,
  TurnStateErrored,
  type Conversation,
} from "../../src/chat/index.ts";
import {
  New,
  openFake,
  sendOneTurn,
  waitForTerminalTurn,
} from "./fakeharness.ts";
import type { Step } from "./fakeharness.ts";

const open = new Set<Conversation>();

async function openTracked(
  script: Parameters<typeof openFake>[0],
): Promise<Conversation> {
  const conv = await openFake(script);
  open.add(conv);
  return conv;
}

afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});

describe("auth required (real pty + fake harness)", () => {
  // claude-code: a settled ready screen (so the idle fallback runs) that shows the
  // logged-out banner instead of a clean composer. promptNotAccepted fires (no ⏺
  // reply, no thinking marker), and the auth scan relabels the errored turn.
  test("claude: logged-out banner on a swallowed turn → ReasonAuthRequired", async () => {
    const script = New("claude-code").Idle().AwaitSubmit().Build();
    const bannerReady: Step = {
      frame: {
        delay_ms: 0,
        // "Claude Code" header + an empty "❯" composer keep readyForInput true so
        // the idle fallback engages; the banner line drives the auth scan.
        screen: "Claude Code\n\n❯ \n\n  Not logged in · Please run /login\n",
        echo: false,
      },
    };
    script.steps.push(bannerReady, { hold: {} });

    const conv = await openTracked(script);
    await sendOneTurn(conv, "do the thing");

    const turn = await waitForTerminalTurn(conv, 4000);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toBe(ReasonAuthRequired);
    expect(turn.text).toBe("");
  });

  // codex: the swallowed-composer shape (prompt still sitting in "› …"), but with a
  // 401 / missing-bearer banner above it. The transcript-override read finds no
  // rollout (fake), so the turn errors — and the auth scan wins over "prompt not
  // accepted". Two AwaitSubmits: the first absorbs the session-id primer's /status.
  test("codex: 401 banner on a swallowed turn → ReasonAuthRequired", async () => {
    const script = New("codex")
      .Idle()
      .AwaitSubmit()
      .Idle()
      .AwaitSubmit()
      .Build();
    const bannerSwallow: Step = {
      frame: {
        delay_ms: 0,
        screen:
          "Codex\n" +
          "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header\n" +
          "\n" +
          "› {{prompt}}\n" +
          "\n" +
          "  codex resume 11111111-2222-3333-4444-555555555555\n",
        echo: true, // substitute the captured prompt into the composer row
      },
    };
    script.steps.push(bannerSwallow, { hold: {} });

    const conv = await openTracked(script);
    await sendOneTurn(conv, "reply with just: ok");

    // 8000 like swallowedprompt.test.ts: codex pays the transcript-override's
    // one-shot flush-lag retry before erroring.
    const turn = await waitForTerminalTurn(conv, 8000);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toBe(ReasonAuthRequired);
    expect(turn.text).toBe("");
  });
});
