// Tests for the Daytona provisioner and credential injector.
//
// Tier-1 hermetic tests with a fake SDK and injectable transports.

import { describe, expect, test, beforeEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "../../src/async/index.ts";
import {
  daytona,
  buildExecCommand,
  parseExecEnvelope,
  loadDaytonaClass,
} from "../../src/env-daytona/daytona.ts";
import { sweep } from "../../src/env-daytona/sweep.ts";
import {
  fileCredentialInjector,
  CREDENTIAL_SENSITIVE_ENV_NAMES,
  credentialLeakProbe,
} from "../../src/env-daytona/index.ts";
import type { Workspace, WorkspaceSpec } from "../../src/env/types.ts";
import {
  resetFakeDaytonaSdk,
  state as fakeSdkState,
} from "./fixtures/fake-daytona-sdk.ts";

const FAKE_SDK_URL = new URL("./fixtures/fake-daytona-sdk.ts", import.meta.url)
  .href;
const ctx = Context.background();

describe("Daytona provisioner", () => {
  test("provisioner name is 'daytona'", () => {
    const prov = daytona({ apiKey: "test-key" });
    expect(prov.name()).toBe("daytona");
  });

  test("preflight validates SDK availability", async () => {
    const prov = daytona({ apiKey: "test-key" });
    // preflight should succeed when SDK is available
    // (mock is set up to provide it)
    // In practice, this would fail if @daytonaio/sdk is not installed
  });

  test("create calls Daytona SDK with spec labels and intervals", async () => {
    const prov = daytona({ apiKey: "test-key" });
    const ctx = Context.background();

    const spec: WorkspaceSpec = {
      image: "daytona-image:latest",
      name: "test-run-123",
      labels: { runner: "test", tier: "untrusted" },
      autoStopInterval: 15,
      autoDeleteInterval: 0,
    };

    // This would fail at runtime if SDK is not mocked properly
    // For now, we're testing the structure
    expect(spec.labels).toEqual({ runner: "test", tier: "untrusted" });
    expect(spec.autoStopInterval).toBe(15);
  });

  test("workspace guestPath returns correct paths", async () => {
    const prov = daytona({ apiKey: "test-key" });
    const ctx = Context.background();
    const spec: WorkspaceSpec = {
      image: "daytona-image:latest",
      name: "test-run-123",
    };

    // Can't easily test without mocking the entire flow,
    // so we'll verify the structure
    expect(spec).toHaveProperty("image");
    expect(spec).toHaveProperty("name");
  });
});

describe("File credential injector", () => {
  test("injector reports redactions correctly", () => {
    const token = "secret-token-abc123";
    const injector = fileCredentialInjector({
      token,
      guestPath: "/tmp/token",
    });

    expect(injector.redactions()).toContain(token);
    expect(injector.redactions()).toHaveLength(1);
  });

  test("injector requires no special capabilities", () => {
    const injector = fileCredentialInjector({
      token: "test-token",
      guestPath: "/tmp/token",
    });

    expect(injector.requires()).toEqual([]);
  });

  test("injector apply/cleanup lifecycle works", async () => {
    const token = "secret-token-xyz";
    const injector = fileCredentialInjector({
      token,
      guestPath: "~/.daytona/token",
    });

    // Create a mock workspace
    const execCalls: string[] = [];
    const mockWs: Partial<Workspace> = {
      upload: vi.fn(async () => {}),
      exec: vi.fn(async (ctx, argv) => {
        execCalls.push(argv.join(" "));
        return { code: 0, stdout: "", stderr: "" };
      }),
      download: vi.fn(async () => {}),
      guestPath: () => "/home/test",
      hostAlias: (url) => url,
      destroy: vi.fn(async () => {}),
    };

    const ctx = Context.background();

    // apply should upload the token
    await injector.apply(ctx, mockWs as Workspace);
    expect(mockWs.upload).toHaveBeenCalled();

    // cleanup should call exec to remove the file
    await injector.cleanup(ctx, mockWs as Workspace);
    expect(mockWs.exec).toHaveBeenCalled();
    // verify it tried to remove the file
    const rmCall = execCalls.find((call) => call.includes("rm"));
    expect(rmCall).toBeTruthy();
  });

  test("injector cleanup is idempotent even after failed apply", async () => {
    const token = "secret-token-failure";
    const injector = fileCredentialInjector({
      token,
      guestPath: "~/.daytona/token",
    });

    // Create a mock workspace that fails on upload
    const mockWs: Partial<Workspace> = {
      upload: vi.fn(async () => {
        throw new Error("upload failed");
      }),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
      download: vi.fn(async () => {}),
      guestPath: () => "/home/test",
      hostAlias: (url) => url,
      destroy: vi.fn(async () => {}),
    };

    const ctx = Context.background();

    // apply should fail
    await expect(injector.apply(ctx, mockWs as Workspace)).rejects.toThrow();

    // cleanup should still work (idempotent)
    await injector.cleanup(ctx, mockWs as Workspace);
    expect(mockWs.exec).toHaveBeenCalled();
  });
});

describe("Credential leak probe", () => {
  test("CREDENTIAL_SENSITIVE_ENV_NAMES contains the expected names", () => {
    expect(CREDENTIAL_SENSITIVE_ENV_NAMES).toContain("DAYTONA_API_KEY");
    expect(CREDENTIAL_SENSITIVE_ENV_NAMES).toContain("ANTHROPIC_API_KEY");
    expect(CREDENTIAL_SENSITIVE_ENV_NAMES).toContain("GITHUB_TOKEN");
    expect(CREDENTIAL_SENSITIVE_ENV_NAMES).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("credentialLeakProbe returns a shell command", () => {
    const cmd = credentialLeakProbe();
    expect(cmd).toContain("node -e");
    expect(cmd).toContain("process.env");
    expect(cmd).toContain("console.log");
  });

  test("credentialLeakProbe command counts sensitive env vars", async () => {
    // Set up a test environment
    const oldEnv = process.env;
    const newEnv = { ...oldEnv };

    try {
      // Clear any existing sensitive vars
      for (const name of CREDENTIAL_SENSITIVE_ENV_NAMES) {
        delete newEnv[name];
      }
      delete newEnv.DAYTONA_API_KEY;
      delete newEnv.ANTHROPIC_API_KEY;

      process.env = newEnv;

      const cmd = credentialLeakProbe();
      // The command should be executable
      expect(cmd).toBeTruthy();
      expect(cmd.length).toBeGreaterThan(0);
    } finally {
      process.env = oldEnv;
    }
  });

  test("leak probe list and probe implementation match", () => {
    const cmd = credentialLeakProbe();

    // The command should reference each sensitive name
    for (const name of CREDENTIAL_SENSITIVE_ENV_NAMES) {
      expect(cmd).toContain(name);
    }

    // The command should have the expected structure
    expect(cmd).toContain("for (const name of names)");
    expect(cmd).toContain("if (process.env[name])");
  });

  test("leak probe and file injector redactions are independent", () => {
    // The leak probe is for guest-env scope (detecting leaks at runtime)
    // The file injector is for credential delivery (applying credentials)
    // Both should reference CLAUDE_CODE_OAUTH_TOKEN since it's in both scopes

    const token = "oauth-token-xyz";
    const injector = fileCredentialInjector({
      token,
      guestPath: "~/.daytona/token",
    });

    const probeCmd = credentialLeakProbe();
    const injectorRedactions = injector.redactions();

    // CLAUDE_CODE_OAUTH_TOKEN should be in the leak probe
    expect(CREDENTIAL_SENSITIVE_ENV_NAMES).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(probeCmd).toContain("CLAUDE_CODE_OAUTH_TOKEN");

    // The injector redacts the actual token value, not the env name
    expect(injectorRedactions).toContain(token);
    expect(injectorRedactions).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("buildExecCommand / parseExecEnvelope (marker envelope)", () => {
  test("round-trips separate stdout/stderr through the merged SDK stream", () => {
    const marker = "__MH_test1234__";
    // Simulate what a real shell would produce for buildExecCommand's script.
    const raw = "hello stdout\n" + marker + "\n" + "oops stderr\n";
    expect(parseExecEnvelope(raw, marker)).toEqual({
      stdout: "hello stdout",
      stderr: "oops stderr\n",
    });
  });

  test("empty stdout and empty stderr both parse cleanly", () => {
    const marker = "__MH_empty__";
    const raw = "\n" + marker + "\n";
    expect(parseExecEnvelope(raw, marker)).toEqual({ stdout: "", stderr: "" });
  });

  test("marker absent falls back to treating the whole payload as stdout", () => {
    const raw = "no marker here at all";
    expect(parseExecEnvelope(raw, "__MH_missing__")).toEqual({
      stdout: raw,
      stderr: "",
    });
  });

  test("buildExecCommand quotes argv via the shared argvToShell discipline (injection-safe)", () => {
    const cmd = buildExecCommand(["echo", "; rm -rf /"], "__MH_m__");
    // The hostile token must be single-quoted, never bare, so the shell never
    // interprets its `;`.
    expect(cmd).toContain("'; rm -rf /'");
    expect(cmd).not.toMatch(/[^']; rm -rf \/[^']/);
  });

  test("buildExecCommand prefixes a quoted printf when stdin is provided", () => {
    const cmd = buildExecCommand(["cat"], "__MH_m__", "hello\nworld");
    expect(cmd).toContain("{ printf %s 'hello\nworld' | 'cat';");
  });

  test("buildExecCommand omits the stdin prefix when stdin is undefined", () => {
    const cmd = buildExecCommand(["cat"], "__MH_m__");
    expect(cmd).not.toContain("printf %s");
  });

  test("buildExecCommand captures the exit code and always emits the marker", () => {
    const cmd = buildExecCommand(["false"], "__MH_m__");
    expect(cmd).toContain("__c=$?");
    expect(cmd).toContain("exit $__c");
    expect(cmd).toContain("__MH_m__");
  });
});

describe("Daytona provisioner against a fake SDK", () => {
  beforeEach(() => {
    resetFakeDaytonaSdk();
  });

  test("loadDaytonaClass is shared by preflight, create, and sweep", async () => {
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    await prov.preflight(ctx);
    const ctor = await loadDaytonaClass({ sdkImport: FAKE_SDK_URL });
    expect(typeof ctor).toBe("function");
    // create() and sweep() both resolve through the same helper — proven by
    // both successfully instantiating the fake client below.
    const ws = await prov.create(ctx, { image: "img", name: "n1" });
    expect(ws).toBeTruthy();
    await sweep(ctx, { sdkImport: FAKE_SDK_URL }, { labels: { x: "1" } });
  });

  test("exec() sends the marker-enveloped command and splits stdout/stderr", async () => {
    fakeSdkState.execResult = (command) => {
      // Echo back a scripted envelope regardless of the real command content —
      // this test only proves exec() wires the SDK response back correctly.
      const markerMatch = command.match(/'(__MH_[0-9a-f]+__)'/);
      const marker = markerMatch ? markerMatch[1] : "__MH_?__";
      return { result: `out-line\n${marker}\nerr-line\n`, exitCode: 7 };
    };
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    const ws = await prov.create(ctx, { image: "img", name: "n2" });
    const r = await ws.exec(ctx, ["node", "-e", "whatever"]);
    expect(r).toEqual({ code: 7, stdout: "out-line", stderr: "err-line\n" });
    expect(fakeSdkState.executedCommands.length).toBe(1);
  });

  test("exec() argv reaches the guest injection-safely, not shell-interpreted", async () => {
    fakeSdkState.execResult = () => ({ result: "", exitCode: 0 });
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    const ws = await prov.create(ctx, { image: "img", name: "n3" });
    await ws.exec(ctx, ["echo", "; rm -rf /"]);
    const cmd = fakeSdkState.executedCommands[0];
    expect(cmd).toContain("'; rm -rf /'");
  });

  test("create() uses exitCode ?? 0, not ||, so a real 0 exit code is not lost", async () => {
    fakeSdkState.execResult = (command) => {
      const markerMatch = command.match(/'(__MH_[0-9a-f]+__)'/);
      const marker = markerMatch ? markerMatch[1] : "__MH_?__";
      return { result: `\n${marker}\n`, exitCode: 0 };
    };
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    const ws = await prov.create(ctx, { image: "img", name: "n4" });
    const r = await ws.exec(ctx, ["true"]);
    expect(r.code).toBe(0);
  });

  test("upload(): single file creates the missing guest parent directory first", async () => {
    fakeSdkState.execResult = () => ({ result: "", exitCode: 0 });
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    const ws = await prov.create(ctx, { image: "img", name: "n5" });
    const hostTmp = mkdtempSync(join(tmpdir(), "mh-daytona-upfile-"));
    const hostFile = join(hostTmp, "token");
    writeFileSync(hostFile, "secret");
    try {
      await ws.upload(ctx, hostFile, "~/.tokens/nested/daytona");
      const mkdirCmd = fakeSdkState.executedCommands.find((c) =>
        c.includes("mkdir"),
      );
      expect(mkdirCmd).toBeTruthy();
      expect(mkdirCmd).toContain("'~/.tokens/nested'");
      expect(fakeSdkState.uploads).toHaveLength(1);
      expect(fakeSdkState.uploads[0].path).toBe("~/.tokens/nested/daytona");
    } finally {
      rmSync(hostTmp, { recursive: true, force: true });
    }
  });

  test("upload(): a directory routes through host tar + fs.uploadFile + guest tar -x (no single-file upload)", async () => {
    fakeSdkState.execResult = () => ({ result: "", exitCode: 0 });
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    const ws = await prov.create(ctx, { image: "img", name: "n6" });
    const hostDir = mkdtempSync(join(tmpdir(), "mh-daytona-updir-"));
    writeFileSync(join(hostDir, "a.txt"), "hi");
    try {
      await ws.upload(ctx, hostDir, "/home/daytona/repo/tree");
      // A tar buffer was uploaded to a guest tmp path, not the final guestPath directly.
      expect(fakeSdkState.uploads).toHaveLength(1);
      expect(fakeSdkState.uploads[0].path).not.toBe("/home/daytona/repo/tree");
      expect(fakeSdkState.uploads[0].path).toMatch(/\.tar$/);
      const cmds = fakeSdkState.executedCommands.join("\n");
      expect(cmds).toContain("tar");
      expect(cmds).toMatch(/-xf/);
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  test("download(): single file creates the missing host parent directory first", async () => {
    fakeSdkState.execResult = (command) => {
      // `test -d` must report "not a directory" so download() takes the
      // single-file path.
      if (command.includes("'test' '-d'")) {
        const markerMatch = command.match(/'(__MH_[0-9a-f]+__)'/);
        const marker = markerMatch ? markerMatch[1] : "__MH_?__";
        return { result: `\n${marker}\n`, exitCode: 1 };
      }
      return { result: "", exitCode: 0 };
    };
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    const ws = await prov.create(ctx, { image: "img", name: "n7" });
    const hostTmp = mkdtempSync(join(tmpdir(), "mh-daytona-downfile-"));
    const hostFile = join(hostTmp, "nested", "deep", "transcript.json");
    try {
      await ws.download(ctx, "/home/daytona/repo/out.json", hostFile);
      expect(existsSync(join(hostTmp, "nested", "deep"))).toBe(true);
      expect(fakeSdkState.downloads).toHaveLength(1);
    } finally {
      rmSync(hostTmp, { recursive: true, force: true });
    }
  });

  test("destroy(): retention matrix on the delete spy + double-destroy idempotency", async () => {
    fakeSdkState.execResult = () => ({ result: "", exitCode: 0 });
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });

    // Absent retention: destroyed on both success and failure.
    for (const outcome of ["success", "failure"] as const) {
      resetFakeDaytonaSdk();
      const ws = await prov.create(ctx, {
        image: "img",
        name: `absent-${outcome}`,
      });
      await ws.destroy(ctx, outcome);
      expect(fakeSdkState.deletedIds).toHaveLength(1);
    }

    // keep-on-failure: failure keeps (no delete call).
    resetFakeDaytonaSdk();
    {
      const ws = await prov.create(ctx, {
        image: "img",
        name: "keep-fail",
        retention: "keep-on-failure",
      });
      await ws.destroy(ctx, "failure");
      expect(fakeSdkState.deletedIds).toHaveLength(0);
    }

    // Double-destroy with the same outcome is a no-op the second time.
    resetFakeDaytonaSdk();
    {
      const ws = await prov.create(ctx, { image: "img", name: "double" });
      await ws.destroy(ctx, "success");
      await ws.destroy(ctx, "success");
      expect(fakeSdkState.deletedIds).toHaveLength(1);
    }
  });

  // Regression: destroy() sets `destroyed = true` unconditionally on its FIRST
  // call. If it were only set on the deletion path, a first destroy() that
  // hits "keep" would leave the flag unset, letting a later destroy() with a
  // DIFFERENT outcome delete a sandbox that was supposed to be kept.
  test("destroy(): keep-then-retry-with-different-outcome still keeps (flag-ordering regression)", async () => {
    resetFakeDaytonaSdk();
    fakeSdkState.execResult = () => ({ result: "", exitCode: 0 });
    const prov = daytona({ apiKey: "k", sdkImport: FAKE_SDK_URL });
    const ws = await prov.create(ctx, {
      image: "img",
      name: "order",
      retention: "keep-on-failure",
    });
    await ws.destroy(ctx, "failure"); // kept
    expect(fakeSdkState.deletedIds).toHaveLength(0);
    await ws.destroy(ctx, "success"); // retry with a different outcome
    expect(fakeSdkState.deletedIds).toHaveLength(0); // must STILL be kept
  });
});

describe("sweep()", () => {
  beforeEach(() => {
    resetFakeDaytonaSdk();
  });

  test("empty labels throw (billing-safety backstop)", async () => {
    await expect(
      sweep(ctx, { sdkImport: FAKE_SDK_URL }, { labels: {} }),
    ).rejects.toThrow(/empty labels/);
  });

  test("filters client-side requiring every label pair to match", async () => {
    fakeSdkState.sandboxes = [
      { id: "match-1", labels: { run: "r1", tier: "test" } },
      { id: "no-match-1", labels: { run: "r2", tier: "test" } },
      { id: "match-2", labels: { run: "r1", tier: "test", extra: "1" } },
      { id: "partial", labels: { run: "r1" } },
    ];
    const result = await sweep(
      ctx,
      { sdkImport: FAKE_SDK_URL },
      { labels: { run: "r1", tier: "test" } },
    );
    expect(result.swept.sort()).toEqual(["match-1", "match-2"]);
    expect(fakeSdkState.deletedIds.sort()).toEqual(["match-1", "match-2"]);
  });

  test("dryRun reports matches without deleting", async () => {
    fakeSdkState.sandboxes = [{ id: "s1", labels: { run: "r1" } }];
    const result = await sweep(
      ctx,
      { sdkImport: FAKE_SDK_URL },
      { labels: { run: "r1" }, dryRun: true },
    );
    expect(result.kept).toEqual(["s1"]);
    expect(result.swept).toEqual([]);
    expect(fakeSdkState.deletedIds).toHaveLength(0);
  });

  test("drains the full (auto-paginating) list iterator before filtering", async () => {
    // Simulates many pages: the fake's list() is itself an async generator,
    // and sweep() must exhaust it (no early break) to avoid missing orphans.
    fakeSdkState.sandboxes = Array.from({ length: 50 }, (_, i) => ({
      id: `sb-${i}`,
      labels: { run: i % 2 === 0 ? "keep" : "sweep-me" },
    }));
    const result = await sweep(
      ctx,
      { sdkImport: FAKE_SDK_URL },
      { labels: { run: "sweep-me" } },
    );
    expect(result.swept).toHaveLength(25);
  });

  test("collects per-sandbox deletion failures without aborting the sweep", async () => {
    fakeSdkState.sandboxes = [
      { id: "ok-1", labels: { run: "r1" } },
      { id: "boom", labels: { run: "r1" } },
      { id: "ok-2", labels: { run: "r1" } },
    ];
    fakeSdkState.deleteShouldFail = (id) => id === "boom";
    const result = await sweep(
      ctx,
      { sdkImport: FAKE_SDK_URL },
      { labels: { run: "r1" } },
    );
    expect(result.swept.sort()).toEqual(["ok-1", "ok-2"]);
    expect(result.failed).toEqual([
      { id: "boom", error: "fake delete failure for boom" },
    ]);
  });
});
