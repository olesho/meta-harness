// OneShotConfig.permissionMode must reach the wrapper Config — the one-shot loop
// is a thin client over a single chat.Open, so the knob is only useful if the
// forward at that seam exists.

import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOneShot } from "../../src/oneshot/index.ts";
import { Context } from "../../src/internal/async/index.ts";
import {
  New,
  PromptRef,
  fakeHarnessBin,
  fakeLaunchEnv,
  testIdleGap,
  testMarkerGap,
} from "../chat/fakeharness.ts";

/** The fake dumps its argv from its own run(); poll for it. */
async function readArgv(path: string): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      if (raw !== "") return JSON.parse(raw) as string[];
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`fake harness never dumped its argv to ${path}`);
}

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
    const argvOut = join(mkdtempSync(join(tmpdir(), "os-argv-")), "argv.json");
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
    const argvOut = join(mkdtempSync(join(tmpdir(), "os-argv-")), "argv.json");
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
