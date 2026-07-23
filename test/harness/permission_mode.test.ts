// TurnConfig.permissionMode must reach the wrapper Config. runTurn forwards a
// possibly-undefined cfg.inputPolicy, so a claude `bypass` here is also the case
// where chat's default trust_prompt policy kicks in (see launchInputPolicy).

import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn } from "../../src/harness/internal/runTurn.ts";
import { TurnStateComplete } from "../../src/chat/index.ts";
import { New, fakeHarnessBin, fakeLaunchEnv } from "../chat/fakeharness.ts";

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
    const argvOut = join(mkdtempSync(join(tmpdir(), "rt-argv-")), "argv.json");

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
    const argvOut = join(mkdtempSync(join(tmpdir(), "rt-argv-")), "argv.json");

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
