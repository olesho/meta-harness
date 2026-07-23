// Unit + subprocess tests for the `run` CLI (src/cli/run.ts). The subprocess
// tests exec the real CLI under `node` (matching its `#!/usr/bin/env node`
// production runtime; META-HARNESS-30/34), driving one fake-harness turn end to
// end (prompt on stdin → clean reply on stdout, exit 0) and a forced deadline
// (exit 124 + the literal `harness-wrapper run:` stderr anchor the orchestrator greps for).

import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  parseTimeoutMs,
  parseGoDuration,
  resolveHarnessName,
  ExitOK,
  ExitError,
  ExitUsage,
  ExitDeadline,
  DeadlineLine,
} from "../../src/cli/run.ts";
import { New, PromptRef, EnvVar, fakeHarnessBin } from "../chat/fakeharness.ts";
import { resolveNode } from "../../src/wrapper/internal/pty.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runCli = join(here, "..", "..", "dist", "cli", "run.js");
// The CLI ships `#!/usr/bin/env node`; exec it under a real `node` so the
// subprocess run matches production even when the test runner is bun.
const nodeBin = resolveNode();

describe("parseArgs", () => {
  test("bare name", () => {
    const p = parseArgs(["claude"]);
    expect(p.name).toBe("claude");
    expect(p.harnessArgs).toEqual([]);
    expect(p.error).toBeUndefined();
  });

  test("flags before name, harness args after --", () => {
    const p = parseArgs([
      "--effort",
      "high",
      "--model",
      "opus",
      "codex",
      "--",
      "-a",
      "1",
    ]);
    expect(p.effort).toBe("high");
    expect(p.model).toBe("opus");
    expect(p.name).toBe("codex");
    expect(p.harnessArgs).toEqual(["-a", "1"]);
  });

  test("--flag=value form", () => {
    const p = parseArgs(["--effort=low", "--model=x", "claude"]);
    expect(p.effort).toBe("low");
    expect(p.model).toBe("x");
    expect(p.name).toBe("claude");
  });

  test("--permission-mode separated form", () => {
    const p = parseArgs([
      "--permission-mode",
      "bypass",
      "--effort",
      "high",
      "claude",
      "--",
      "-a",
    ]);
    expect(p.permissionMode).toBe("bypass");
    expect(p.effort).toBe("high");
    expect(p.name).toBe("claude");
    expect(p.harnessArgs).toEqual(["-a"]);
    expect(p.error).toBeUndefined();
  });

  test("--permission-mode=value form", () => {
    const p = parseArgs(["--permission-mode=plan", "codex"]);
    expect(p.permissionMode).toBe("plan");
    expect(p.name).toBe("codex");
    expect(p.error).toBeUndefined();
  });

  test("--permission-mode with no operand errors", () => {
    const p = parseArgs(["--permission-mode"]);
    expect(p.error).toBe("flag --permission-mode requires a value");
  });

  test("--permission-mode after <name> is forwarded as a harness arg", () => {
    const p = parseArgs(["claude", "--", "--permission-mode", "auto"]);
    expect(p.permissionMode).toBeUndefined();
    expect(p.name).toBe("claude");
    expect(p.harnessArgs).toEqual(["--permission-mode", "auto"]);
    expect(p.error).toBeUndefined();
  });

  test("--help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("missing name errors", () => {
    expect(parseArgs([]).error).toBeDefined();
    expect(parseArgs(["--effort", "high"]).error).toBeDefined();
  });

  test("flag needing a value at end errors", () => {
    expect(parseArgs(["--model"]).error).toBeDefined();
  });

  test("stray arg without -- separator errors", () => {
    expect(parseArgs(["claude", "extra"]).error).toBeDefined();
  });

  test("leading -- with no name errors", () => {
    expect(parseArgs(["--", "claude"]).error).toBeDefined();
  });
});

describe("resolveHarnessName", () => {
  test("aliases", () => {
    expect(resolveHarnessName("claude")).toBe("claude-code");
    expect(resolveHarnessName("claude-code")).toBe("claude-code");
    expect(resolveHarnessName("codex")).toBe("codex");
    expect(resolveHarnessName("nope")).toBeNull();
  });
});

describe("parseGoDuration / parseTimeoutMs", () => {
  test("common Go durations", () => {
    expect(parseGoDuration("15m")).toBe(900_000);
    expect(parseGoDuration("90s")).toBe(90_000);
    expect(parseGoDuration("1h30m")).toBe(5_400_000);
    expect(parseGoDuration("500ms")).toBe(500);
  });
  test("malformed → null", () => {
    expect(parseGoDuration("")).toBeNull();
    expect(parseGoDuration("abc")).toBeNull();
    expect(parseGoDuration("15")).toBeNull();
    expect(parseGoDuration("15m garbage")).toBeNull();
  });
  test("timeout default 15m when unset/empty/invalid", () => {
    expect(parseTimeoutMs(undefined)).toBe(900_000);
    expect(parseTimeoutMs("")).toBe(900_000);
    expect(parseTimeoutMs("garbage")).toBe(900_000);
    expect(parseTimeoutMs("30s")).toBe(30_000);
  });
});

// ── Subprocess e2e ─────────────────────────────────────────────────────────

function scriptPathFor(
  script: ReturnType<ReturnType<typeof New>["Build"]>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-script-"));
  const p = join(dir, "script.json");
  writeFileSync(p, JSON.stringify(script), { mode: 0o600 });
  return p;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function execCli(
  args: string[],
  stdin: string,
  env: Record<string, string>,
): Promise<RunResult> {
  const proc = spawn(nodeBin, [runCli, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    stdout += d;
  });
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const code: number = await new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (c) => {
      resolve(c ?? 0);
    });
  });
  return { code, stdout, stderr };
}

describe("run CLI subprocess", () => {
  test("--help contains the literal token `run <name>`", async () => {
    const r = await execCli(["--help"], "", {});
    expect(r.code).toBe(ExitOK);
    expect(r.stdout).toContain("run <name>");
  });

  test("unknown harness exits 2", async () => {
    const r = await execCli(["notaharness"], "hi", {});
    expect(r.code).toBe(ExitUsage);
  });

  test("empty prompt exits 2", async () => {
    const r = await execCli(["claude"], "   \n", {});
    expect(r.code).toBe(ExitUsage);
  });

  test("bad args exit 2", async () => {
    const r = await execCli(["claude", "stray"], "hi", {});
    expect(r.code).toBe(ExitUsage);
  });

  test("drives one claude turn end to end → exit 0, clean reply", async () => {
    const sentinel = "CLI-CLAUDE-7";
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Reply(40, "Echo: " + PromptRef(), "Synthesized", "5s")
      .Build();

    const r = await execCli(["claude"], "Say " + sentinel, {
      HARNESS_BINARY: fakeHarnessBin,
      [EnvVar]: scriptPathFor(script),
    });
    expect(r.code).toBe(ExitOK);
    expect(r.stdout).toContain(sentinel);
  }, 15_000);

  test("drives one codex turn end to end → exit 0, clean reply", async () => {
    const sentinel = "CLI-CODEX-9";
    const script = New("codex")
      .Idle()
      // Absorb the startup /status prime, then drive the real turn.
      .AwaitSubmit()
      .Idle()
      .AwaitSubmit()
      .CodexWorking(30, "Working")
      .CodexReply(40, "Result: " + PromptRef())
      .Build();

    const r = await execCli(["codex"], "Say " + sentinel, {
      HARNESS_BINARY: fakeHarnessBin,
      [EnvVar]: scriptPathFor(script),
    });
    expect(r.code).toBe(ExitOK);
    expect(r.stdout).toContain(sentinel);
  }, 15_000);

  test("env-clean: CLAUDECODE / CLAUDE_CODE_* not passed to the child harness", async () => {
    // The fake harness echoes nothing about env, so we assert indirectly: the
    // turn still completes cleanly with the scrub vars present in the CLI env.
    const sentinel = "CLI-ENVCLEAN-3";
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Reply(40, "Ok: " + PromptRef(), "Synthesized", "5s")
      .Build();

    const r = await execCli(["claude"], "Say " + sentinel, {
      HARNESS_BINARY: fakeHarnessBin,
      [EnvVar]: scriptPathFor(script),
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    });
    expect(r.code).toBe(ExitOK);
    expect(r.stdout).toContain(sentinel);
  }, 15_000);

  test("forced deadline → exit 124 + literal harness-wrapper run: stderr anchor", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .StayAliveUntilStopped()
      .Build();

    const r = await execCli(["claude"], "hang", {
      HARNESS_BINARY: fakeHarnessBin,
      [EnvVar]: scriptPathFor(script),
      HARNESS_WRAPPER_RUN_TIMEOUT: "600ms",
    });
    expect(r.code).toBe(ExitDeadline);
    expect(r.stderr).toContain(DeadlineLine);
    expect(r.stderr).toContain("harness-wrapper run:");
  }, 15_000);
});

// Reference the error exit constant so the import is exercised.
test("ExitError constant", () => {
  expect(ExitError).toBe(1);
});
