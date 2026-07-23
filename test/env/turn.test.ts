// Tier-1 suite for the host-side structured-turn client. Drives runStructuredTurn
// over a fake Workspace and asserts: the prompt crosses via a temp-file upload
// (NEVER argv, even for hostile prompts), the frozen JSON parse, and the no-JSON
// exit paths (usage / prompt-read-failure / fatal) alongside 124 + DeadlineLine.

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { Context } from "../../src/async/index.ts";
import {
  runStructuredTurn,
  TurnProtocolError,
  TranscriptRetrievalUnsupportedError,
  type TurnConfig,
} from "../../src/env/index.ts";
import { DeadlineLine } from "../../src/turnproto/index.ts";
import type { Context as Ctx } from "../../src/async/index.ts";
import type { ExecOpts, ExecResult, Workspace } from "../../src/env/index.ts";

const ctx = Context.background();

// A Workspace double that captures the exec argv/opts, reads uploaded prompt
// CONTENT before the host temp dir is cleaned up, and scripts an exec result.
class TurnFakeWorkspace implements Workspace {
  execArgv: string[] = [];
  execOpts?: ExecOpts;
  uploadedPrompt?: string;
  uploadGuestPath?: string;
  uploadCount = 0;
  downloads: [string, string][] = [];
  constructor(private readonly result: ExecResult) {}

  async exec(_ctx: Ctx, argv: string[], opts?: ExecOpts): Promise<ExecResult> {
    this.execArgv = argv;
    this.execOpts = opts;
    return this.result;
  }
  async upload(_ctx: Ctx, hostPath: string, guestPath: string): Promise<void> {
    this.uploadCount++;
    this.uploadedPrompt = readFileSync(hostPath, "utf8"); // still exists mid-turn
    this.uploadGuestPath = guestPath;
  }
  async download(
    _ctx: Ctx,
    guestPath: string,
    hostPath: string,
  ): Promise<void> {
    this.downloads.push([guestPath, hostPath]);
  }
  guestPath(kind: "repo" | "home" | "tmp"): string {
    return `/inner/${kind}`;
  }
  hostAlias(hostUrl: string): string {
    return hostUrl;
  }
  async destroy(): Promise<void> {}
}

const okLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: "completed",
    reply: "hi",
    harnessSessionID: "sess-1",
    transcript_entries: [],
    working_dir: "/repo",
    ...over,
  }) + "\n";

const cfg = (over: Partial<TurnConfig> = {}): TurnConfig => ({
  harness: "claude",
  prompt: "do the thing",
  ...over,
});

describe("runStructuredTurn — happy path & transport", () => {
  test("returns the parsed JSON result", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.status).toBe("completed");
    expect(res.reply).toBe("hi");
    expect(res.harnessSessionID).toBe("sess-1");
  });

  test("a result line with NO permission_mode still parses (every pre-field producer)", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.status).toBe("completed");
    expect(res.permission_mode).toBeUndefined();
    // ...and a producer that DOES send it is returned verbatim, unvalidated:
    // the field is `string`, so an unrecognised value crosses opaquely rather
    // than being mapped onto a rung.
    const ws2 = new TurnFakeWorkspace({
      code: 0,
      stdout: okLine({ permission_mode: "override" }),
      stderr: "",
    });
    expect((await runStructuredTurn(ctx, ws2, cfg())).permission_mode).toBe(
      "override",
    );
  });

  test("prompt crosses via temp-file upload, NEVER argv", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg({ prompt: "secret prompt body" }));
    expect(ws.uploadedPrompt).toBe("secret prompt body");
    expect(ws.uploadGuestPath).toBe("/inner/tmp/meta-harness-prompt.txt");
    // argv carries only the FILE path, and no token equals the prompt text.
    expect(ws.execArgv).toContain("--prompt-file");
    expect(ws.execArgv).toContain("/inner/tmp/meta-harness-prompt.txt");
    expect(ws.execArgv).not.toContain("secret prompt body");
  });

  test("HOSTILE prompt never leaks into argv", async () => {
    const hostile = `"; rm -rf / #\n$(whoami)\n\`id\`\n--effort=evil`;
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg({ prompt: hostile }));
    expect(ws.uploadedPrompt).toBe(hostile);
    for (const tok of ws.execArgv) expect(tok).not.toContain("rm -rf");
    expect(ws.execArgv.filter((t) => t === "--effort")).toHaveLength(0);
  });

  test("threads binary, effort, model, sandboxDefaults, harnessArgs into argv order", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(
      ctx,
      ws,
      cfg({
        binary: "/opt/bin/mh-structured",
        effort: "high",
        model: "sonnet",
        sandboxDefaults: true,
        harnessArgs: ["--foo", "bar"],
      }),
    );
    // --sandbox-defaults is a RUNNER flag: it must sit BEFORE <name>, never
    // after `--` where it would be forwarded to the harness.
    expect(ws.execArgv).toEqual([
      "/opt/bin/mh-structured",
      "--prompt-file",
      "/inner/tmp/meta-harness-prompt.txt",
      "--effort",
      "high",
      "--model",
      "sonnet",
      "--sandbox-defaults",
      "claude",
      "--",
      "--foo",
      "bar",
    ]);
  });

  test("sandboxDefaults defaults OFF — no --sandbox-defaults on the argv", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg());
    expect(ws.execArgv).not.toContain("--sandbox-defaults");
  });

  test("permissionMode lands as an adjacent --permission-mode pair before <name>", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg({ permissionMode: "plan" }));
    expect(ws.execArgv).toEqual([
      "meta-harness-structured-run",
      "--prompt-file",
      "/inner/tmp/meta-harness-prompt.txt",
      "--permission-mode",
      "plan",
      "claude",
    ]);
    // ...and it is a RUNNER flag: it sits before the harness name, not after `--`.
    const i = ws.execArgv.indexOf("--permission-mode");
    expect(ws.execArgv[i + 1]).toBe("plan");
    expect(i).toBeLessThan(ws.execArgv.indexOf("claude"));
  });

  test("permissionMode unset injects nothing", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg({ permissionMode: undefined }));
    expect(ws.execArgv).not.toContain("--permission-mode");
  });

  test('permissionMode "" means unset — no empty flag pair on the argv', async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg({ permissionMode: "" }));
    expect(ws.execArgv).not.toContain("--permission-mode");
    expect(ws.execArgv).not.toContain("");
  });

  // D — the two flags COMPOSE: both reach the runner argv, no throw. The slot
  // order is load-bearing: --permission-mode sits AFTER --model and immediately
  // BEFORE --sandbox-defaults, so an argv with no mode set stays byte-identical
  // to what callers got before the flag existed. Precedence between the two is
  // then resolved inside the runner (metaHarnessArgs), not here.
  test("sandboxDefaults + permissionMode COMPOSE — both on the argv, in slot order", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    const res = await runStructuredTurn(
      ctx,
      ws,
      cfg({
        effort: "high",
        model: "sonnet",
        sandboxDefaults: true,
        permissionMode: "plan",
      }),
    );
    expect(res.status).toBe("completed");
    expect(ws.uploadCount).toBe(1);
    expect(ws.execArgv).toEqual([
      "meta-harness-structured-run",
      "--prompt-file",
      "/inner/tmp/meta-harness-prompt.txt",
      "--effort",
      "high",
      "--model",
      "sonnet",
      "--permission-mode",
      "plan",
      "--sandbox-defaults",
      "claude",
    ]);
  });

  // D′ — the empty-mode guard, and the ONLY thing that makes "the two guards
  // cannot drift" true rather than aspirational. buildArgv's predicate here and
  // metaHarnessArgs's in src/cli/structured-runner.ts are literally the same
  // (`!== undefined && !== ""`) but live in different files with no shared
  // constant: this test pins THIS one, the runner's case E pins that one. Were
  // this guard tidied into the neighbours' one-clause `!== undefined` shape, a
  // bare `--permission-mode ""` would reach the runner, which reads it as unset
  // — and --sandbox-defaults's argv half would vanish on both sides at once.
  test('sandboxDefaults + permissionMode "" — empty mode is unset, sugar survives', async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(
      ctx,
      ws,
      cfg({ sandboxDefaults: true, permissionMode: "" }),
    );
    expect(ws.uploadCount).toBe(1);
    expect(ws.execArgv).toContain("--sandbox-defaults");
    expect(ws.execArgv).not.toContain("--permission-mode");
  });

  test("sandboxDefaults alone still behaves exactly as before", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    const res = await runStructuredTurn(
      ctx,
      ws,
      cfg({ sandboxDefaults: true }),
    );
    expect(res.status).toBe("completed");
    expect(ws.uploadCount).toBe(1);
    expect(ws.execArgv).toEqual([
      "meta-harness-structured-run",
      "--prompt-file",
      "/inner/tmp/meta-harness-prompt.txt",
      "--sandbox-defaults",
      "claude",
    ]);
  });

  test("passes env and cwd through exec opts (cwd defaults to repo)", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg({ env: { K: "V" } }));
    expect(ws.execOpts?.env).toEqual({ K: "V" });
    expect(ws.execOpts?.cwd).toBe("/inner/repo");
  });
});

describe("runStructuredTurn — no-JSON exit paths (never assume a payload)", () => {
  test("exit 2 (usage) with no JSON → startup_error, reason from stderr", async () => {
    const ws = new TurnFakeWorkspace({
      code: 2,
      stdout: "",
      stderr: "structured-runner: unknown harness: bogus\n",
    });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.status).toBe("startup_error");
    expect(res.reply).toBe("");
    expect(res.reason).toContain("unknown harness");
  });

  test("the derived result NEVER carries permission_mode — not even when requested", async () => {
    // No turn ran, so there is no launch rung to report. Synthesising one from
    // the host's own cfg.permissionMode would fabricate a guest report and make
    // "the guest binary predates the field" indistinguishable from "the guest
    // confirmed the flag survived" — the diagnostic the absence exists to give.
    const ws = new TurnFakeWorkspace({
      code: 2,
      stdout: "",
      stderr: "structured-runner: unknown harness: bogus\n",
    });
    const res = await runStructuredTurn(
      ctx,
      ws,
      cfg({ permissionMode: "plan" }),
    );
    expect(res.status).toBe("startup_error");
    expect("permission_mode" in res).toBe(false);
  });

  test("exit 1 (prompt-read failure) with no JSON → errored", async () => {
    const ws = new TurnFakeWorkspace({
      code: 1,
      stdout: "",
      stderr: "structured-runner: failed to read prompt file: ENOENT\n",
    });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.status).toBe("errored");
    expect(res.reason).toContain("failed to read prompt file");
  });

  test("exit 1 (top-level fatal) with no JSON → errored", async () => {
    const ws = new TurnFakeWorkspace({
      code: 1,
      stdout: "",
      stderr: "structured-runner: fatal: boom\n",
    });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.status).toBe("errored");
    expect(res.reason).toContain("fatal");
  });

  test("exit 124 with no JSON → deadline (DeadlineLine on stderr)", async () => {
    const ws = new TurnFakeWorkspace({
      code: 124,
      stdout: "",
      stderr: DeadlineLine + "\n",
    });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.status).toBe("deadline");
  });

  test("exit 124 WITH JSON → the JSON payload wins (source of truth)", async () => {
    const ws = new TurnFakeWorkspace({
      code: 124,
      stdout: okLine({ status: "deadline", reply: "" }),
      stderr: DeadlineLine + "\n",
    });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.status).toBe("deadline");
    expect(res.harnessSessionID).toBe("sess-1");
  });

  test("exit 0 with NO JSON is anomalous → throws TurnProtocolError", async () => {
    const ws = new TurnFakeWorkspace({
      code: 0,
      stdout: "just a banner\n",
      stderr: "",
    });
    await expect(runStructuredTurn(ctx, ws, cfg())).rejects.toBeInstanceOf(
      TurnProtocolError,
    );
  });

  test("derives reason from exit code when stderr is empty", async () => {
    const ws = new TurnFakeWorkspace({ code: 2, stdout: "", stderr: "" });
    const res = await runStructuredTurn(ctx, ws, cfg());
    expect(res.reason).toContain("exited 2");
  });
});

describe("runStructuredTurn — out-of-band transcript retrieval (harness-aware)", () => {
  test("claude-code downloads the encodedCWD project JSONL to the host path", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(
      ctx,
      ws,
      cfg({ harness: "claude", retrieveTranscriptTo: "/host/out.jsonl" }),
    );
    expect(ws.downloads).toEqual([
      ["/inner/home/.claude/projects/-repo/sess-1.jsonl", "/host/out.jsonl"],
    ]);
  });

  test("codex retrieval is REJECTED, not misrouted to the claude path", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await expect(
      runStructuredTurn(
        ctx,
        ws,
        cfg({ harness: "codex", retrieveTranscriptTo: "/host/out.jsonl" }),
      ),
    ).rejects.toBeInstanceOf(TranscriptRetrievalUnsupportedError);
    expect(ws.downloads).toHaveLength(0);
  });

  test("no retrieval when retrieveTranscriptTo is unset", async () => {
    const ws = new TurnFakeWorkspace({ code: 0, stdout: okLine(), stderr: "" });
    await runStructuredTurn(ctx, ws, cfg());
    expect(ws.downloads).toHaveLength(0);
  });

  test("skips retrieval when the session id is empty", async () => {
    const ws = new TurnFakeWorkspace({
      code: 0,
      stdout: okLine({ harnessSessionID: "" }),
      stderr: "",
    });
    await runStructuredTurn(
      ctx,
      ws,
      cfg({ harness: "claude-code", retrieveTranscriptTo: "/host/out.jsonl" }),
    );
    expect(ws.downloads).toHaveLength(0);
  });
});
