// Behavioral coverage for the two auth-signal reachability fixes, the TS mirror
// of pkg/chat/auth_paths_test.go:
//   Fix A — a logged-out claude turn that ends on a "✻ … for 0s" end-of-turn
//           MARKER (not an error) is relabeled ReasonAuthRequired instead of
//           completing as a false success with the banner screen as its "reply".
//   Fix B — an onboarding WALL (never-signed-in menu / first-run wizard) is
//           not-ready and never becomes ready, so send() short-circuits to
//           ReasonAuthRequired instead of hanging to the run deadline.
// Plus pure-function coverage of the readyForInput change that enables Fix B.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { Context } from "../../src/internal/async/index.ts";
import {
  ReasonAuthRequired,
  TurnStateErrored,
  authRequired,
  onboardingWall,
  readyForInput,
  type Conversation,
} from "../../src/chat/index.ts";
import {
  New,
  openFake,
  sendOneTurn,
  waitForTerminalTurn,
} from "./fakeharness.ts";
import type { Step } from "./fakeharness.ts";

const corpusRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../corpus/auth",
);
const screenOf = (name: string): string =>
  readFileSync(join(corpusRoot, name, "screen.txt"), "utf8");

// --- Fix B enabler (pure functions on real captured screens) ---
describe("onboardingWall / readyForInput", () => {
  for (const fx of ["codex/onboarding", "claude-code/theme-picker"]) {
    const harness = fx.startsWith("codex") ? "codex" : "claude-code";
    test(`${fx}: onboarding wall is not-ready`, () => {
      const s = screenOf(fx);
      expect(onboardingWall(harness, s)).toBe(true);
      expect(readyForInput(harness, s)).toBe(false); // enables Fix B
      expect(authRequired(harness, s)).toBe(true);
    });
  }
  test("claude not-logged-in banner is NOT an onboarding wall (stays ready; Fix A handles it)", () => {
    const s = screenOf("claude-code/not-logged-in-brewed");
    expect(onboardingWall("claude-code", s)).toBe(false);
    expect(authRequired("claude-code", s)).toBe(true);
  });
  test("codex normal composer is not an onboarding wall", () => {
    expect(onboardingWall("codex", screenOf("codex/normal-composer"))).toBe(
      false,
    );
  });
});

// --- behavioral (real pty + fake harness) ---
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

describe("auth reachability (real pty + fake harness)", () => {
  // Fix A: the banner rides on a screen that ALSO carries the end-of-turn marker
  // ("✻ Brewed for 0s"), so the turn completes via the marker path (endMarkerSeen)
  // — NOT the promptNotAccepted branch. Without Fix A this is a false success
  // (banner persisted as the reply). readyForInput stays true (this is a composer
  // with a stale banner, not an onboarding wall), so the turn is actually sent.
  test("claude: logged-out banner WITH end-of-turn marker → ReasonAuthRequired", async () => {
    const script = New("claude-code").Idle().AwaitSubmit().Build();
    const bannerWithMarker: Step = {
      frame: {
        delay_ms: 0,
        screen:
          "Claude Code\n\n❯ do the thing\n" +
          "  ⎿  Not logged in · Please run /login\n\n" +
          "✻ Brewed for 0s\n\n❯ \n",
        echo: false,
      },
    };
    script.steps.push(bannerWithMarker, { hold: {} });

    const conv = await openTracked(script);
    await sendOneTurn(conv, "do the thing");

    const turn = await waitForTerminalTurn(conv, 6000);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toBe(ReasonAuthRequired);
    expect(turn.text).toBe("");
  });

  // Fix B: the idle screen is a never-signed-in onboarding menu. It never becomes
  // ready, so send()'s waitReadyForSend short-circuits with ErrAuthRequired and
  // records a ReasonAuthRequired turn instead of hanging to the deadline.
  test("codex: onboarding wall at idle → ReasonAuthRequired (no deadline hang)", async () => {
    const script = New("codex").Build();
    const onboarding: Step = {
      frame: {
        delay_ms: 0,
        screen:
          "Welcome to Codex, OpenAI's command-line coding agent\n\n" +
          "> 1. Sign in with ChatGPT\n" +
          "  2. Sign in with Device Code\n" +
          "  3. Provide your own API key\n\n" +
          "Press enter to continue\n",
        echo: false,
      },
    };
    script.steps.push(onboarding, { hold: {} });

    const conv = await openTracked(script);
    await sendOneTurn(conv, "reply with just: ok");

    const turn = await waitForTerminalTurn(conv, 6000);
    expect(turn.state).toBe(TurnStateErrored);
    expect(turn.reason).toBe(ReasonAuthRequired);
  });
});
