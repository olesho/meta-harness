// Unit + hermetic-tmux tests for src/cli/tmux.ts. The full spawn->attach
// round trip (which needs a working --tmux-child re-exec, i.e. a real
// process.argv[1] pointing at the compiled CLI) lives in wrapper.test.ts,
// spawning dist/cli/wrapper.js under node. Here, runTmuxStatus/Kill/List are
// exercised against a tmux session created directly via a raw `tmux
// new-session` call — those three functions only ever shell out to tmux by
// session name, so they don't need the re-exec path to be tested for real.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildReexecArgv,
  requireTmux,
  resolveTracePath,
  runTmuxKill,
  runTmuxList,
  runTmuxSpawn,
  runTmuxStatus,
  TMUX_SESSION_PREFIX,
  validSessionName,
} from "../../src/cli/tmux.ts";
import type { HarnessWrapperArgs } from "../../src/cli/wrapperFlags.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

describe("validSessionName", () => {
  test.each([
    ["a", true],
    ["a-b_c9", true],
    ["A".repeat(64), true],
    ["", false],
    ["A".repeat(65), false],
    ["has/slash", false],
    ["has..dots", false],
    ["has:colon", false],
    ["has space", false],
  ])("validSessionName(%j) === %j", (input, want) => {
    expect(validSessionName(input)).toBe(want);
  });
});

describe("requireTmux", () => {
  test("reflects real tmux availability on PATH", () => {
    const err = requireTmux();
    if (hasTmux) expect(err).toBeNull();
    else expect(err?.message).toContain("tmux not found");
  });
});

describe("resolveTracePath", () => {
  test("explicit path is absolutized verbatim", () => {
    const { result, err } = resolveTracePath(
      "relative/trace.ndjson",
      "ignored",
    );
    expect(err).toBeNull();
    expect(result).toBe(join(process.cwd(), "relative/trace.ndjson"));
  });

  test("default falls back to ~/.meta-harness/sessions/<name>.trace.ndjson", () => {
    const { result, err } = resolveTracePath("", "my-session");
    expect(err).toBeNull();
    expect(result).toBe(
      join(homedir(), ".meta-harness", "sessions", "my-session.trace.ndjson"),
    );
  });
});

function baseArgs(overrides: Partial<HarnessWrapperArgs>): HarnessWrapperArgs {
  return {
    traceFile: "",
    traceStderr: false,
    effort: "",
    model: "",
    permissionMode: "",
    tmuxSession: "",
    tmuxChild: "",
    harnessName: "claude",
    harnessArgs: [],
    ...overrides,
  };
}

/** Runs `run`, capturing everything it writes to process.stdout as a string. */
function captureStdout(run: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = (chunk: string | Uint8Array) => {
    captured +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

// No tmux binary required: buildReexecArgv is the pure argv-construction seam
// extracted out of runTmuxSpawn precisely so the forwarding contract (every
// launch-time knob survives the detached re-exec) is testable hermetically.
describe("buildReexecArgv", () => {
  const TRACE = "/tmp/t.ndjson";

  function argvFor(overrides: Partial<HarnessWrapperArgs>): string[] {
    return buildReexecArgv(
      baseArgs({ tmuxSession: "sess", ...overrides }),
      TRACE,
    );
  }

  test("baseline shape: --tmux-child, --trace-file, harness name, -- , harness args", () => {
    expect(argvFor({ harnessArgs: ["-p", "hi"] })).toEqual([
      process.execPath,
      process.argv[1] ?? "",
      "--tmux-child",
      "sess",
      "--trace-file",
      TRACE,
      "claude",
      "--",
      "-p",
      "hi",
    ]);
  });

  test("forwards --permission-mode as an adjacent pair, before the harness name", () => {
    const argv = argvFor({ permissionMode: "plan" });
    const i = argv.indexOf("--permission-mode");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("plan");
    expect(i).toBeLessThan(argv.indexOf("claude"));
  });

  test("omits --permission-mode entirely when empty", () => {
    expect(argvFor({})).not.toContain("--permission-mode");
  });

  test("forwards effort, model and permission mode together, all before the harness name", () => {
    const argv = argvFor({
      effort: "high",
      model: "opus",
      permissionMode: "bypass",
      harnessArgs: ["-p", "hi"],
    });
    expect(argv).toEqual([
      process.execPath,
      process.argv[1] ?? "",
      "--tmux-child",
      "sess",
      "--trace-file",
      TRACE,
      "--effort",
      "high",
      "--model",
      "opus",
      "--permission-mode",
      "bypass",
      "claude",
      "--",
      "-p",
      "hi",
    ]);
  });

  test("a flag-shaped harness arg after -- is not mistaken for a forwarded wrapper flag", () => {
    const argv = argvFor({ harnessArgs: ["--permission-mode", "nope"] });
    // The only --permission-mode present is the harness's own, after the separator.
    expect(argv.indexOf("--permission-mode")).toBeGreaterThan(
      argv.indexOf("--"),
    );
  });
});

describe("runTmuxSpawn — --tmux-session validation", () => {
  test("rejects an invalid session name (exit 2) before ever invoking tmux or writing a trace-file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrapper-tmux-test-"));
    const tracePath = join(dir, "should-not-be-created.trace.ndjson");
    try {
      const code = runTmuxSpawn(
        baseArgs({ tmuxSession: "has/slash", traceFile: tracePath }),
      );
      expect(code).toBe(2);
      expect(existsSync(tracePath)).toBe(false);
      // No tmux session should exist for the malformed name either.
      if (hasTmux) {
        const has = spawnSync("tmux", [
          "has-session",
          "-t",
          TMUX_SESSION_PREFIX + "has/slash",
        ]);
        expect(has.status).not.toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty --tmux-session is rejected the same way, independent of tmux availability", () => {
    const code = runTmuxSpawn(baseArgs({ tmuxSession: "" }));
    expect(code).toBe(2);
  });
});

describe.skipIf(!hasTmux)(
  "runTmuxStatus / runTmuxKill / runTmuxList — real tmux round trip",
  () => {
    test("status/list/kill against a session created directly via tmux", () => {
      const name = `ws3-test-${String(process.pid)}`;
      const tmuxName = TMUX_SESSION_PREFIX + name;
      const spawnResult = spawnSync("tmux", [
        "new-session",
        "-d",
        "-s",
        tmuxName,
        "sleep",
        "60",
      ]);
      expect(spawnResult.status).toBe(0);

      try {
        const listed = captureStdout(() => {
          expect(runTmuxList([])).toBe(0);
        });
        expect(listed.split("\n")).toContain(name);

        const statusOut = captureStdout(() => {
          expect(runTmuxStatus([name, "--json"])).toBe(0);
        });
        const parsed = JSON.parse(statusOut) as {
          session: string;
          alive: boolean;
        };
        expect(parsed.session).toBe(name);
        expect(parsed.alive).toBe(true);
      } finally {
        expect(runTmuxKill([name])).toBe(0);
      }

      const has = spawnSync("tmux", ["has-session", "-t", tmuxName]);
      expect(has.status).not.toBe(0);
    });

    test("status on a never-existing session reports alive=false and a default trace path", () => {
      const name = `ws3-nonexistent-${String(process.pid)}`;
      const statusOut = captureStdout(() => {
        expect(runTmuxStatus([name, "--json"])).toBe(0);
      });
      const parsed = JSON.parse(statusOut) as {
        alive: boolean;
        trace: string;
      };
      expect(parsed.alive).toBe(false);
      expect(parsed.trace).toBe(
        join(homedir(), ".meta-harness", "sessions", `${name}.trace.ndjson`),
      );
    });

    test("kill on a never-existing session fails (non-zero)", () => {
      const code = runTmuxKill([`ws3-nonexistent-kill-${String(process.pid)}`]);
      expect(code).not.toBe(0);
    });
  },
);
