// TurnConfig.permissionMode must reach the wrapper Config. runTurn forwards a
// possibly-undefined cfg.inputPolicy, so a claude `bypass` here is also the case
// where chat's default bypass_acceptance policy kicks in (see
// launchInputPolicy; PUPPET-526 split that kind out of `trust_prompt`).

import { describe, expect, test } from "vitest";
import { runTurn } from "../../src/harness/internal/runTurn.ts";
import { TurnStateComplete } from "../../src/chat/index.ts";
import {
  New,
  argvOutPath,
  fakeHarnessBin,
  fakeLaunchEnv,
  readArgv,
} from "../chat/fakeharness.ts";

function turnScript() {
  return New("claude-code")
    .Idle()
    .AwaitSubmit()
    .Working(30, "Working")
    .Reply(40, "assistant reply", "Baked", "1s")
    .Build();
}

describe("runTurn permissionMode forwarding", () => {
  test("`plan` launches claude with --permission-mode plan", async () => {
    const argvOut = argvOutPath("rt-argv-");

    const result = await runTurn(undefined, {
      harness: "claude",
      binaryPath: fakeHarnessBin,
      env: fakeLaunchEnv(turnScript(), argvOut),
      prompt: "plan the work",
      permissionMode: "plan",
      exitAfterTurn: true,
    });
    expect(result.turn.state).toBe(TurnStateComplete);

    const argv = await readArgv(argvOut);
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
  }, 30000);

  test("an unset permissionMode injects nothing", async () => {
    const argvOut = argvOutPath("rt-argv-");

    const result = await runTurn(undefined, {
      harness: "claude",
      binaryPath: fakeHarnessBin,
      env: fakeLaunchEnv(turnScript(), argvOut),
      prompt: "no knob",
      exitAfterTurn: true,
    });
    expect(result.turn.state).toBe(TurnStateComplete);

    const argv = await readArgv(argvOut);
    expect(argv).not.toContain("--permission-mode");
  }, 30000);
});
