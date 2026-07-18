// Port of pkg/turns/harness/claudecode/turncomplete_busy_test.go.

import { describe, expect, test } from "vitest";
import * as claudecode from "../../../src/turns/harness/claudecode.ts";
import type { Event } from "../../../src/turns/index.ts";
import { TurnComplete } from "../../../src/turns/index.ts";
import { textSnap } from "../corpus.ts";

function hasTurnComplete(evs: Event[]): boolean {
  return evs.some((e) => e.kind === TurnComplete);
}

describe("claude-code turn-complete gated on busy", () => {
  test("intermediate marker while busy must not complete", () => {
    const a = claudecode.New();
    const busy = textSnap(
      "✻ Pondered for 3s\n⏵⏵ bypass permissions on · esc to interrupt",
    );
    expect(hasTurnComplete(a.onScreen(busy))).toBe(false);
    const idle = textSnap(
      "✻ Baked for 12s\n❯ \n⏵⏵ auto mode on · ← for agents",
    );
    expect(hasTurnComplete(a.onScreen(idle))).toBe(true);
  });

  test("gated on sub-agent spinner", () => {
    const a = claudecode.New();
    const working = textSnap(
      "⏺ I'll verify the facts first.\n✻ Pondered for 12s\n" +
        "✶ Cerebrating… (57s · ↓ 4.8k tokens)\n  ◯ Explore  Verify types   24s · ↓ 35.8k tokens\n❯ ",
    );
    expect(hasTurnComplete(a.onScreen(working))).toBe(false);
    const done = textSnap(
      "⏺ Here is the revised plan…\n✻ Synthesized for 2m 3s\n❯ \n⏵⏵ auto mode on · ← for agents",
    );
    expect(hasTurnComplete(a.onScreen(done))).toBe(true);
  });
});
