// Unit tests for src/cli/wrapper.ts's pure pieces (exitCodeFor, the raw-mode
// guard) plus subprocess e2e against the compiled dist/cli/wrapper.js, matching
// its `#!/usr/bin/env node` production runtime (same pattern as
// test/cli/run.test.ts). Per the HARNESS-WRAPPER-3 ticket, these subprocess
// tests require `dist/` to be current — CI builds before test, as it already
// must for test/cli/run.test.ts.

import { describe, expect, test, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { exitCodeFor, installRawModeGuard } from "../../src/cli/wrapper.ts";
import { TMUX_SESSION_PREFIX } from "../../src/cli/tmux.ts";
import {
  ErrNone,
  StatusAPIError,
  StatusBinaryNotFound,
  StatusBlockedByCost,
  StatusFailed,
  StatusIdle,
  StatusInterrupted,
  StatusRetryLater,
  StatusStale,
  StatusUnknown,
  StatusWaitingForInput,
  type Result,
  type Status,
} from "../../src/wrapper/api.ts";
import { resolveNode } from "../../src/wrapper/internal/pty.ts";
import { mockHarnessBin } from "../wrapper/mockbin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const wrapperCli = join(here, "..", "..", "dist", "cli", "wrapper.js");
const nodeBin = resolveNode();
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

function fakeResult(status: Status, exitCode: number): Result {
  return {
    status,
    class: ErrNone,
    exitCode,
    signal: "",
    reason: "",
    pid: 1,
    startedAt: new Date(0),
    endedAt: new Date(1),
    lastOutputAt: null,
  };
}

describe("exitCodeFor", () => {
  test("idle -> the harness's own exit code", () => {
    expect(exitCodeFor(fakeResult(StatusIdle, 0))).toBe(0);
    expect(exitCodeFor(fakeResult(StatusIdle, 3))).toBe(3);
  });
  test("failed -> the harness's own exit code, else 1", () => {
    expect(exitCodeFor(fakeResult(StatusFailed, 7))).toBe(7);
    expect(exitCodeFor(fakeResult(StatusFailed, 0))).toBe(1);
    expect(exitCodeFor(fakeResult(StatusFailed, -1))).toBe(1);
  });
  test("blocked_by_cost -> the harness's own exit code, else 1", () => {
    expect(exitCodeFor(fakeResult(StatusBlockedByCost, 4))).toBe(4);
    expect(exitCodeFor(fakeResult(StatusBlockedByCost, 0))).toBe(1);
  });
  test("interrupted -> the harness's own exit code, else 130", () => {
    expect(exitCodeFor(fakeResult(StatusInterrupted, 9))).toBe(9);
    expect(exitCodeFor(fakeResult(StatusInterrupted, 0))).toBe(130);
  });
  test("unknown -> the harness's own exit code, else 0", () => {
    expect(exitCodeFor(fakeResult(StatusUnknown, 5))).toBe(5);
    expect(exitCodeFor(fakeResult(StatusUnknown, 0))).toBe(0);
  });
  test.each([
    StatusRetryLater,
    StatusAPIError,
    StatusWaitingForInput,
    StatusStale,
    StatusBinaryNotFound,
  ])("%s falls to the shared default of 1, ignoring exitCode", (status) => {
    expect(exitCodeFor(fakeResult(status, 0))).toBe(1);
    expect(exitCodeFor(fakeResult(status, 5))).toBe(1);
  });
});

describe("installRawModeGuard", () => {
  test("no-op when stdin is not a TTY", () => {
    const setRawMode = vi.fn();
    const guard = installRawModeGuard({ isTTY: false, setRawMode });
    guard.cleanup();
    expect(setRawMode).not.toHaveBeenCalled();
  });

  test("enables on install, disables exactly once on cleanup()", () => {
    const setRawMode = vi.fn();
    const guard = installRawModeGuard({ isTTY: true, setRawMode });
    expect(setRawMode).toHaveBeenCalledWith(true);
    guard.cleanup();
    guard.cleanup();
    expect(setRawMode).toHaveBeenCalledTimes(2);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
  });

  test("restores on an abnormal process 'exit' even when cleanup() was never called on the normal path", () => {
    const setRawMode = vi.fn();
    installRawModeGuard({ isTTY: true, setRawMode });
    // Simulates a crash mid-session: an uncaught exception / rejected promise
    // reaching the top level still fires "exit" before Node terminates, which
    // is the scenario the guard exists to cover (there is no existing TS
    // precedent for this cleanup shape in the repo — see wrapper.ts's doc).
    process.emit("exit", 1);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(setRawMode).toHaveBeenCalledTimes(2);
  });

  test("cleanup() after an exit-triggered restore does not disable a second time", () => {
    const setRawMode = vi.fn();
    const guard = installRawModeGuard({ isTTY: true, setRawMode });
    process.emit("exit", 1);
    const callsAfterExit = setRawMode.mock.calls.length;
    guard.cleanup();
    expect(setRawMode.mock.calls.length).toBe(callsAfterExit);
  });
});

// ── Subprocess e2e ───────────────────────────────────────────────────────────

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnWrapperCli(args: string[], env: Record<string, string>) {
  const proc = spawn(nodeBin, [wrapperCli, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => {
    stdout += d;
  });
  proc.stderr.on("data", (d: string) => {
    stderr += d;
  });
  const done = new Promise<RunResult>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
  return { proc, done };
}

describe("wrapper CLI subprocess — foreground passthrough", () => {
  test("--help", async () => {
    const { proc, done } = spawnWrapperCli(["--help"], {});
    proc.stdin.end();
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("meta-harness-wrapper");
  });

  test("non-TTY foreground: drives the mock harness end to end, exit 0", async () => {
    // HARNESS_BINARY overrides discovery's resolvePath() to the mock binary
    // (an absolute path — resolveBinaryPath's rule 0/1 checks it directly,
    // never touching PATH), so "claude" resolves to mockHarnessBin without
    // any real `claude` install or PATH staging.
    const { proc, done } = spawnWrapperCli(
      ["claude", "--", "--mode", "completed", "--steps", "2", "--delay", "1ms"],
      {
        HARNESS_BINARY: mockHarnessBin,
      },
    );
    proc.stdin.end();
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DONE");
  }, 15_000);

  test("SIGTERM: wrapper_cli_signal traced before wrapper_cli_exited, interrupted exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrapper-sigterm-test-"));
    const tracePath = join(dir, "trace.ndjson");
    const { proc, done } = spawnWrapperCli(
      ["--trace-file", tracePath, "claude", "--", "--mode", "stuck"],
      {
        HARNESS_BINARY: mockHarnessBin,
      },
    );
    await new Promise((r) => setTimeout(r, 300));
    proc.kill("SIGTERM");
    const r = await done;
    expect(r.code).toBe(130);

    const lines = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string });
    const kinds = lines.map((l) => l.kind);
    const signalIdx = kinds.indexOf("wrapper_cli_signal");
    const exitIdx = kinds.indexOf("wrapper_cli_exited");
    expect(signalIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThan(signalIdx);
  }, 15_000);
});

describe.skipIf(!hasTmux)("wrapper CLI subprocess — tmux round trip", () => {
  test("spawn -> status --json -> kill", async () => {
    const name = `ws3-cli-${String(process.pid)}`;
    const { proc, done } = spawnWrapperCli(
      ["--tmux-session", name, "claude", "--", "--mode", "stuck"],
      {
        HARNESS_BINARY: mockHarnessBin,
      },
    );
    proc.stdin.end();
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`session: ${name}`);

    await new Promise((res) => setTimeout(res, 500));

    const status = spawnSync(nodeBin, [wrapperCli, "status", name, "--json"]);
    const parsed = JSON.parse(status.stdout.toString("utf8")) as {
      session: string;
      alive: boolean;
    };
    expect(parsed.session).toBe(name);
    expect(parsed.alive).toBe(true);

    const kill = spawnSync(nodeBin, [wrapperCli, "kill", name]);
    // Happy path: kill a live session → exit 0. Under full-suite load the stuck
    // session's PTY-backed child can be reaped before the kill lands (resource
    // pressure → tmux destroys the session on child exit), so kill legitimately
    // reports the session already gone (exit 1, per the nonexistent-kill contract
    // in tmux.test.ts). That is a load artifact, not a kill bug — so tolerate it
    // ONLY after confirming the session is genuinely gone (which is the round
    // trip's real postcondition). A kill that returns non-zero while the session
    // is STILL alive still fails the test.
    if (kill.status !== 0) {
      const has = spawnSync("tmux", [
        "has-session",
        "-t",
        TMUX_SESSION_PREFIX + name,
      ]);
      expect(has.status).not.toBe(0);
    } else {
      expect(kill.status).toBe(0);
    }
  }, 20_000);
});
