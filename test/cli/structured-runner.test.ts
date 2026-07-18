// Structured sandbox runner — arg grammar (safe transport) + a real one-turn
// integration over the fake harness asserting the JSON result-line contract.

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  main,
  parseStructuredArgs,
  ExitOK,
} from "../../src/cli/structured-runner.ts";
import { New, PromptRef, EnvVar, fakeHarnessBin } from "../chat/fakeharness.ts";

describe("parseStructuredArgs (safe-transport grammar)", () => {
  test("captures --prompt-file, effort, model, name, and forwarded harness args", () => {
    const p = parseStructuredArgs([
      "--prompt-file",
      "/run/prompt.txt",
      "--effort",
      "high",
      "--model",
      "gpt-5.3",
      "claude",
      "--",
      "--dangerously-skip-permissions",
      "--foo",
    ]);
    expect(p.error).toBeUndefined();
    expect(p.promptFile).toBe("/run/prompt.txt");
    expect(p.effort).toBe("high");
    expect(p.model).toBe("gpt-5.3");
    expect(p.name).toBe("claude");
    expect(p.harnessArgs).toEqual(["--dangerously-skip-permissions", "--foo"]);
  });

  test("the prompt is NEVER an argument — a value with shell metacharacters stays a path", () => {
    // The prompt only ever arrives via --prompt-file's PATH; nothing lets a prompt
    // body (quotes/newlines/leading dash) reach argv, so it can't corrupt parsing.
    const weird = "/tmp/a b'\"$(x)`.txt";
    const p = parseStructuredArgs(["--prompt-file", weird, "codex"]);
    expect(p.error).toBeUndefined();
    expect(p.promptFile).toBe(weird);
    expect(p.name).toBe("codex");
    expect(p.harnessArgs).toEqual([]);
  });

  test("supports --flag=value form", () => {
    const p = parseStructuredArgs([
      "--prompt-file=/p",
      "--effort=low",
      "claude",
    ]);
    expect(p.promptFile).toBe("/p");
    expect(p.effort).toBe("low");
    expect(p.name).toBe("claude");
  });

  test("rejects a missing name, unknown flag, valueless flag, and bare trailing arg", () => {
    expect(parseStructuredArgs(["--prompt-file", "/p"]).error).toMatch(
      /missing <name>/,
    );
    expect(parseStructuredArgs(["--bogus", "claude"]).error).toMatch(
      /unknown flag/,
    );
    expect(parseStructuredArgs(["--prompt-file"]).error).toMatch(
      /requires a value/,
    );
    expect(parseStructuredArgs(["claude", "extra"]).error).toMatch(
      /must follow/,
    );
  });

  test("-h/--help short-circuits", () => {
    expect(parseStructuredArgs(["--help"]).help).toBe(true);
    expect(parseStructuredArgs(["-h"]).help).toBe(true);
  });
});

describe("structured-runner main() — one-turn JSON contract (real pty + fake harness)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "HARNESS_BINARY_CLAUDE_CODE",
    EnvVar,
    "LOOM_WORKTREE_PATH",
    "LOOM_LOCAL_TASK_TIMEOUT_MS",
  ];
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  function setEnv(k: string, v: string) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  async function captureMain(
    argv: string[],
  ): Promise<{ code: number; payload: any }> {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    };
    let code: number;
    try {
      code = await main(argv);
    } finally {
      process.stdout.write = orig;
    }
    const line =
      chunks.join("").trim().split("\n").filter(Boolean).pop() ?? "{}";
    return { code, payload: JSON.parse(line) };
  }

  test("completed: emits one JSON line with reply + harnessSessionID; transcript read is best-effort", async () => {
    const SID = "cli1234-0000-0000-0000-000000000001";
    const sentinel = "STRUCTURED-OK";
    const script = New("claude-code")
      .Session(SID)
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .Reply(40, "Answer: " + PromptRef(), "Synthesized", "5s")
      .Build();
    const scriptPath = join(
      mkdtempSync(join(tmpdir(), "sr-script-")),
      "script.json",
    );
    writeFileSync(scriptPath, JSON.stringify(script), { mode: 0o600 });
    const promptPath = join(
      mkdtempSync(join(tmpdir(), "sr-prompt-")),
      "prompt.txt",
    );
    writeFileSync(promptPath, "Reply with " + sentinel);
    const wd = mkdtempSync(join(tmpdir(), "sr-wd-"));

    setEnv("HARNESS_BINARY_CLAUDE_CODE", fakeHarnessBin);
    setEnv(EnvVar, scriptPath);
    setEnv("LOOM_WORKTREE_PATH", wd);
    setEnv("LOOM_LOCAL_TASK_TIMEOUT_MS", "20000");

    const { code, payload } = await captureMain([
      "--prompt-file",
      promptPath,
      "claude",
    ]);

    expect(code).toBe(ExitOK);
    expect(payload.status).toBe("completed");
    expect(payload.reply).toContain(sentinel);
    expect(payload.working_dir).toBe(wd);
    // The JSON contract must carry every key the host parses. (The exact
    // harnessSessionID value depends on the fake harness's idle-screen extraction
    // timing, which needs the fast test idle-gaps main() intentionally does NOT
    // inject; runOneShotDetailed's own tests cover id capture. Here we assert the
    // field is present in the contract.)
    expect(typeof payload.harnessSessionID).toBe("string");
    expect(payload).toHaveProperty("transcript_entries");
    // The fake harness writes no on-disk claude transcript, so the in-guest read
    // finds nothing — a graceful empty array (or a captured transcript_error),
    // NEVER a crash that erases the reply.
    expect(Array.isArray(payload.transcript_entries)).toBe(true);
    // Same for usage: no on-disk session → the usage key is simply absent
    // (best-effort telemetry, never a crash). Fixture-level extraction is
    // covered in test/transcript/usage.test.ts.
    expect(payload.usage).toBeUndefined();
  }, 25000);
});

test("readUsage: empty session id → null (no locate attempted)", async () => {
  const { readUsage } = await import("../../src/cli/structured-runner.ts");
  expect(readUsage("claude-code", "", "/tmp")).toBeNull();
  expect(readUsage("codex", "", "/tmp")).toBeNull();
});
