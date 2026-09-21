// OneShotConfig.permissionMode must reach the wrapper Config — the one-shot loop
// is a thin client over a single chat.Open, so the knob is only useful if the
// forward at that seam exists.

import { describe, expect, test } from "vitest";
import { runOneShot } from "../../src/oneshot/index.ts";
import { Context } from "../../src/internal/async/index.ts";
import {
  New,
  PromptRef,
  argvOutPath,
  fakeHarnessBin,
  fakeLaunchEnv,
  readArgv,
  testIdleGap,
  testMarkerGap,
} from "../chat/fakeharness.ts";

function oneShotScript() {
  return New("claude-code")
    .Idle()
    .AwaitSubmit()
    .Working(30, "Thinking")
    .Reply(40, "Answer: " + PromptRef(), "Synthesized", "5s")
    .Build();
}

describe("runOneShot permissionMode forwarding", () => {
  test("`bypass` launches claude with --permission-mode bypassPermissions", async () => {
    const argvOut = argvOutPath("os-argv-");
    const { ctx, cancel } = Context.withDeadline(Context.background(), 8000);
    try {
      await runOneShot(ctx, {
        harness: "claude-code",
        binaryPath: fakeHarnessBin,
        prompt: "Reply with OK",
        env: fakeLaunchEnv(oneShotScript(), argvOut),
        permissionMode: "bypass",
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      });
    } finally {
      cancel();
    }

    const argv = await readArgv(argvOut);
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe(
      "bypassPermissions",
    );
  }, 20000);

  test("an unset permissionMode injects nothing", async () => {
    const argvOut = argvOutPath("os-argv-");
    const { ctx, cancel } = Context.withDeadline(Context.background(), 8000);
    try {
      await runOneShot(ctx, {
        harness: "claude-code",
        binaryPath: fakeHarnessBin,
        prompt: "Reply with OK",
        env: fakeLaunchEnv(oneShotScript(), argvOut),
        idleGap: testIdleGap,
        markerGap: testMarkerGap,
      });
    } finally {
      cancel();
    }

    const argv = await readArgv(argvOut);
    expect(argv).not.toContain("--permission-mode");
  }, 20000);
});
