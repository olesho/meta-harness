// Structured sandbox runner — arg grammar (safe transport) + a real one-turn
// integration over the fake harness asserting the JSON result-line contract.

import { afterEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  main,
  parseStructuredArgs,
  buildGuestEnv,
  resolveTimeoutMs,
  ExitOK,
  ExitDeadline,
  ExitUsage,
  DeadlineLine,
} from "../../src/cli/structured-runner.ts";
import { DEFAULT_RUN_TIMEOUT_MS } from "../../src/turnproto/index.ts";
import {
  New,
  PromptRef,
  EnvVar,
  ArgvOutVar,
  fakeHarnessBin,
} from "../chat/fakeharness.ts";
import { resolveNode } from "../../src/wrapper/internal/pty.ts";

const here = dirname(fileURLToPath(import.meta.url));
// The subprocess tests exec the COMMITTED compiled artifact (there is no in-test
// build), mirroring run.test.ts. Rebuild + commit dist when src changes.
const structuredCli = join(
  here,
  "..",
  "..",
  "dist",
  "cli",
  "structured-runner.js",
);
// The CLI ships `#!/usr/bin/env node`; exec it under a real `node` so the
// subprocess run matches production even when the test runner is bun.
const nodeBin = resolveNode();

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

  test("--sandbox-defaults before <name> sets the flag; absent by default", () => {
    const on = parseStructuredArgs([
      "--prompt-file",
      "/p",
      "--sandbox-defaults",
      "claude",
      "--",
      "--foo",
    ]);
    expect(on.error).toBeUndefined();
    expect(on.sandboxDefaults).toBe(true);
    expect(on.harnessArgs).toEqual(["--foo"]);
    const off = parseStructuredArgs(["--prompt-file", "/p", "claude"]);
    expect(off.error).toBeUndefined();
    expect(off.sandboxDefaults).toBeUndefined();
  });

  test("--sandbox-defaults is valueless — the = form is rejected with the exact message", () => {
    expect(parseStructuredArgs(["--sandbox-defaults=x", "claude"]).error).toBe(
      "flag --sandbox-defaults takes no value",
    );
  });

  test("--sandbox-defaults after <name> hits the positional rejection (runner grammar only)", () => {
    const p = parseStructuredArgs([
      "--prompt-file",
      "/p",
      "claude",
      "--sandbox-defaults",
      "--",
      "x",
    ]);
    expect(p.error).toMatch(
      /unexpected argument: --sandbox-defaults \(harness args must follow/,
    );
  });
});

describe("buildGuestEnv (frozen sandbox-defaults env semantics)", () => {
  const isSandbox = (env: string[]) =>
    env.filter((e) => e.startsWith("IS_SANDBOX="));

  test("flag on, no host IS_SANDBOX → IS_SANDBOX=1 injected", () => {
    const env = buildGuestEnv({ FOO: "bar" }, true);
    expect(isSandbox(env)).toEqual(["IS_SANDBOX=1"]);
    expect(env).toContain("FOO=bar");
  });

  test("flag off, no host IS_SANDBOX → nothing injected", () => {
    const env = buildGuestEnv({ FOO: "bar" }, false);
    expect(isSandbox(env)).toEqual([]);
    expect(env).toContain("FOO=bar");
  });

  test("flag on, host-preset IS_SANDBOX → ONE entry, overwritten to 1 (no duplicate)", () => {
    const env = buildGuestEnv({ IS_SANDBOX: "0", FOO: "bar" }, true);
    expect(isSandbox(env)).toEqual(["IS_SANDBOX=1"]);
  });

  test("flag off, host-preset IS_SANDBOX → passes through VERBATIM (not stripped or rewritten)", () => {
    const env = buildGuestEnv({ IS_SANDBOX: "host-set", FOO: "bar" }, false);
    expect(isSandbox(env)).toEqual(["IS_SANDBOX=host-set"]);
  });
});

describe("structured-runner main() — one-turn JSON contract (real pty + fake harness)", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "HARNESS_BINARY_CLAUDE_CODE",
    EnvVar,
    ArgvOutVar,
    "LOOM_WORKTREE_PATH",
    "LOOM_LOCAL_TASK_TIMEOUT_MS",
    "HARNESS_WRAPPER_RUN_TIMEOUT",
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
  // deleteEnv records the value like setEnv so the afterEach restore covers it —
  // a var exported by the developer/CI environment can't leak into a test that
  // needs it unset, and is put back afterwards.
  function deleteEnv(k: string) {
    saved[k] = process.env[k];
    delete process.env[k];
  }

  async function captureMain(
    argv: string[],
  ): Promise<{ code: number; payload: any; stderr: string }> {
    const chunks: string[] = [];
    const errChunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    };
    process.stderr.write = (chunk: string | Uint8Array) => {
      errChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    };
    let code: number;
    try {
      code = await main(argv);
    } finally {
      process.stdout.write = orig;
      process.stderr.write = origErr;
    }
    const line =
      chunks.join("").trim().split("\n").filter(Boolean).pop() ?? "{}";
    return { code, payload: JSON.parse(line), stderr: errChunks.join("") };
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

  // stageTurn wires a minimal one-turn scenario through process.env (the same
  // setEnv mechanism as above — main() spreads process.env into the guest env,
  // which is how the fake harness receives its script AND its argv-dump path).
  function stageTurn(): { promptPath: string; argvOut: string } {
    const script = New("claude-code")
      .Session("cli1234-0000-0000-0000-000000000002")
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
    writeFileSync(promptPath, "Reply with OK");
    const argvOut = join(mkdtempSync(join(tmpdir(), "sr-argv-")), "argv.json");

    setEnv("HARNESS_BINARY_CLAUDE_CODE", fakeHarnessBin);
    setEnv(EnvVar, scriptPath);
    setEnv(ArgvOutVar, argvOut);
    setEnv("LOOM_WORKTREE_PATH", mkdtempSync(join(tmpdir(), "sr-wd-")));
    setEnv("LOOM_LOCAL_TASK_TIMEOUT_MS", "20000");
    return { promptPath, argvOut };
  }

  test("--sandbox-defaults: --dangerously-skip-permissions PRESENT in the child argv", async () => {
    const { promptPath, argvOut } = stageTurn();
    const { code } = await captureMain([
      "--prompt-file",
      promptPath,
      "--sandbox-defaults",
      "claude",
    ]);
    expect(code).toBe(ExitOK);
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).toContain("--dangerously-skip-permissions");
  }, 25000);

  test("default (no flag): no silent injection — --dangerously-skip-permissions ABSENT", async () => {
    const { promptPath, argvOut } = stageTurn();
    const { code } = await captureMain(["--prompt-file", promptPath, "claude"]);
    expect(code).toBe(ExitOK);
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    expect(argv).not.toContain("--dangerously-skip-permissions");
  }, 25000);

  test("forced deadline via HARNESS_WRAPPER_RUN_TIMEOUT: exit 124 + JSON status deadline + stderr anchor", async () => {
    const script = New("claude-code")
      .Idle()
      .AwaitSubmit()
      .Working(30, "Thinking")
      .StayAliveUntilStopped()
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
    writeFileSync(promptPath, "hang");
    const wd = mkdtempSync(join(tmpdir(), "sr-wd-"));

    setEnv("HARNESS_BINARY_CLAUDE_CODE", fakeHarnessBin);
    setEnv(EnvVar, scriptPath);
    setEnv("LOOM_WORKTREE_PATH", wd);
    // The shared var must apply on its own — the loom override stays unset.
    deleteEnv("LOOM_LOCAL_TASK_TIMEOUT_MS");
    setEnv("HARNESS_WRAPPER_RUN_TIMEOUT", "600ms");

    const { code, payload, stderr } = await captureMain([
      "--prompt-file",
      promptPath,
      "claude",
    ]);

    // The full deadline contract: coarse exit code, the JSON result line
    // (emitted BEFORE the stderr anchor), and the frozen DeadlineLine.
    expect(code).toBe(ExitDeadline);
    expect(payload.status).toBe("deadline");
    expect(stderr).toContain(DeadlineLine);
  }, 25000);

  describe("resolveTimeoutMs precedence (LOOM ms → HARNESS_WRAPPER_RUN_TIMEOUT → default)", () => {
    test("both set → LOOM_LOCAL_TASK_TIMEOUT_MS wins (structured-runner-only override)", () => {
      setEnv("LOOM_LOCAL_TASK_TIMEOUT_MS", "12000");
      setEnv("HARNESS_WRAPPER_RUN_TIMEOUT", "5m");
      expect(resolveTimeoutMs(process.env)).toBe(12_000);
    });

    test("invalid LOOM + valid HARNESS_WRAPPER_RUN_TIMEOUT → the Go-duration var applies", () => {
      // Behavior change vs the old runner: a malformed LOOM value no longer
      // collapses straight to the default — the shared var gets its turn.
      setEnv("LOOM_LOCAL_TASK_TIMEOUT_MS", "not-a-number");
      setEnv("HARNESS_WRAPPER_RUN_TIMEOUT", "5m");
      expect(resolveTimeoutMs(process.env)).toBe(300_000);
    });

    test("LOOM keeps plain-Number() parsing: scientific notation and floats pass", () => {
      setEnv("LOOM_LOCAL_TASK_TIMEOUT_MS", "1e4");
      setEnv("HARNESS_WRAPPER_RUN_TIMEOUT", "5m");
      expect(resolveTimeoutMs(process.env)).toBe(10_000);
    });

    test("neither set → shared 15m default", () => {
      deleteEnv("LOOM_LOCAL_TASK_TIMEOUT_MS");
      deleteEnv("HARNESS_WRAPPER_RUN_TIMEOUT");
      expect(resolveTimeoutMs(process.env)).toBe(DEFAULT_RUN_TIMEOUT_MS);
    });
  });
});

// ── Subprocess e2e: prompt on stdin (Go structured-run parity) ───────────────

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
  const proc = spawn(nodeBin, [structuredCli, ...args], {
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

/** lastJson parses the LAST stdout line as the structured result the host reads. */
function lastJson(stdout: string): any {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line);
}

// Cases 1 & 2 drive a *completing* harness turn, so they wire the fake-harness
// env trio (HARNESS_BINARY_CLAUDE_CODE, EnvVar, LOOM_WORKTREE_PATH) — otherwise
// the subprocess spawns a real claude/codex binary and hangs. structured-runner
// reads LOOM_WORKTREE_PATH (a var run.ts does not use), so it must be set.
function completingTurnEnv(): { env: Record<string, string>; wd: string } {
  const SID = "cli1234-0000-0000-0000-000000000042";
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
  const wd = mkdtempSync(join(tmpdir(), "sr-wd-"));
  return {
    wd,
    env: {
      HARNESS_BINARY_CLAUDE_CODE: fakeHarnessBin,
      [EnvVar]: scriptPath,
      LOOM_WORKTREE_PATH: wd,
      LOOM_LOCAL_TASK_TIMEOUT_MS: "20000",
    },
  };
}

describe("structured-runner subprocess — prompt on stdin", () => {
  test("happy path: prompt piped on stdin (no --prompt-file) → exit 0, reply reflects stdin", async () => {
    const sentinel = "STDIN-SENTINEL-7";
    const { env, wd } = completingTurnEnv();
    const r = await execCli(["claude"], "Reply with " + sentinel, env);
    expect(r.code).toBe(ExitOK);
    const payload = lastJson(r.stdout);
    expect(payload.status).toBe("completed");
    // The fake harness's reply embeds PromptRef() → the ACTUAL forwarded prompt,
    // so the sentinel piped on stdin round-trips into the reply.
    expect(payload.reply).toContain(sentinel);
    expect(payload.working_dir).toBe(wd);
  }, 25_000);

  test("precedence: --prompt-file wins; stdin ignored", async () => {
    const fileSentinel = "FILE-SENTINEL-A";
    const stdinSentinel = "STDIN-SENTINEL-B";
    const { env } = completingTurnEnv();
    const promptPath = join(
      mkdtempSync(join(tmpdir(), "sr-prompt-")),
      "prompt.txt",
    );
    writeFileSync(promptPath, "Reply with " + fileSentinel);
    const r = await execCli(
      ["--prompt-file", promptPath, "claude"],
      "Reply with " + stdinSentinel,
      env,
    );
    expect(r.code).toBe(ExitOK);
    const payload = lastJson(r.stdout);
    expect(payload.status).toBe("completed");
    // File wins: the reply reflects the file sentinel, never the piped stdin one.
    expect(payload.reply).toContain(fileSentinel);
    expect(payload.reply).not.toContain(stdinSentinel);
  }, 25_000);

  test("empty stdin (no --prompt-file) → exit 2 with `empty prompt` (short-circuits before harness)", async () => {
    // Short-circuits at the .trim() pre-flight before any harness launch, so it
    // needs NO fake-harness env — mirroring run.test.ts's empty-prompt case.
    const r = await execCli(["claude"], "   \n", {});
    expect(r.code).toBe(ExitUsage);
    expect(r.stderr).toContain("empty prompt");
  }, 15_000);

  test("--help usage line drops `required` and documents stdin fallback", async () => {
    const r = await execCli(["--help"], "", {});
    expect(r.code).toBe(ExitOK);
    expect(r.stdout).toContain("[--prompt-file <path>]");
    expect(r.stdout).toContain("falls back to stdin");
  }, 15_000);
});

test("readUsage: empty session id → null (no locate attempted)", async () => {
  const { readUsage } = await import("../../src/cli/structured-runner.ts");
  expect(readUsage("claude-code", "", "/tmp")).toBeNull();
  expect(readUsage("codex", "", "/tmp")).toBeNull();
});
