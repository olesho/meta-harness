// META-HARNESS-125: the codex adapter's /permissions capability seam — the
// dialog open/backout/clear keystrokes (pinned to the live-probe bytes,
// META-HARNESS-122), the launch-env binding, and the containment predicate
// that gates a preset commit on the write actually landing in an isolated,
// caller-named CODEX_HOME rather than the harness's real global config.

import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import * as codex from "../../../src/turns/harness/codex.ts";
import { writeCodexRollout } from "../../chat/helpers.ts";

const dec = new TextDecoder();

describe("codex permissions dialog keystrokes", () => {
  test("permissionsDialogKeys is /permissions + CSI 13 u", () => {
    const keys = codex.New().permissionsDialogKeys();
    expect(dec.decode(keys)).toBe("/permissions\x1b[13u");
  });

  test("dialogBackoutKeys is a bare ESC", () => {
    const keys = codex.New().dialogBackoutKeys();
    expect(dec.decode(keys)).toBe("\x1b");
    expect(keys.length).toBe(1);
  });

  test("composerClearKeys is Ctrl-U", () => {
    const keys = codex.New().composerClearKeys();
    expect(dec.decode(keys)).toBe("\x15");
    expect(keys.length).toBe(1);
  });
});

describe("codex permissionsWriteContained", () => {
  test("never bound (fresh adapter) → false", () => {
    const a = codex.New();
    expect(a.permissionsWriteContained("/tmp/whatever")).toBe(false);
  });

  test("bound with CODEX_HOME absent from the launch env → false", () => {
    const a = codex.New();
    a.bindLaunchEnv(["HOME=" + homedir()], "");
    expect(a.boundCodexHome).toBe("");
    expect(a.permissionsWriteContained(join(homedir(), ".codex"))).toBe(false);
  });

  test("bound but declaredHome names a DIFFERENT path → false", () => {
    // Proves an ambient/inherited CODEX_HOME cannot satisfy the gate: the
    // caller must separately DECLARE the same isolated home it launched with.
    const a = codex.New();
    const isolated = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      a.bindLaunchEnv(["CODEX_HOME=" + isolated], "");
      expect(a.permissionsWriteContained("/some/other/path")).toBe(false);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("both equal to the real ~/.codex → false", () => {
    const a = codex.New();
    const real = join(homedir(), ".codex");
    a.bindLaunchEnv(["CODEX_HOME=" + real], "");
    expect(a.permissionsWriteContained(real)).toBe(false);
  });

  test("both naming the same isolated tmp home → true", () => {
    const a = codex.New();
    const isolated = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      a.bindLaunchEnv(["CODEX_HOME=" + isolated], "");
      expect(a.permissionsWriteContained(isolated)).toBe(true);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("differing but equivalent spellings still agree — trailing slash", () => {
    const a = codex.New();
    const isolated = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      a.bindLaunchEnv(["CODEX_HOME=" + isolated], "");
      expect(a.permissionsWriteContained(isolated + "/")).toBe(true);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("differing but equivalent spellings still agree — relative path", () => {
    const a = codex.New();
    const isolated = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      a.bindLaunchEnv(["CODEX_HOME=" + isolated], "");
      const rel = relative(process.cwd(), isolated);
      expect(a.permissionsWriteContained(rel)).toBe(true);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("codex bindLaunchEnv", () => {
  test("CODEX_HOME present and sessionsRoot empty → sessionsRoot follows it", () => {
    const a = codex.New();
    const isolated = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      expect(a.sessionsRoot).toBe("");
      a.bindLaunchEnv(["CODEX_HOME=" + isolated], "");
      expect(a.sessionsRoot).toBe(join(isolated, "sessions"));

      // readTranscript / locateSessionID follow the isolated home: a rollout
      // written under it is found without any extra wiring.
      const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      writeCodexRollout(a.sessionsRoot, uuid, "/some/cwd");
      const turns = a.readTranscript(uuid, "/some/cwd");
      expect(turns.length).toBeGreaterThan(0);
      const [locatedID, ok] = a.locateSessionID("/some/cwd");
      expect(ok).toBe(true);
      expect(locatedID).toBe(uuid);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("sessionsRoot already assigned → untouched", () => {
    const a = codex.New();
    const preset = mkdtempSync(join(tmpdir(), "codex-preset-"));
    const isolated = mkdtempSync(join(tmpdir(), "codex-home-"));
    try {
      a.sessionsRoot = preset;
      a.bindLaunchEnv(["CODEX_HOME=" + isolated], "");
      expect(a.sessionsRoot).toBe(preset);
    } finally {
      rmSync(preset, { recursive: true, force: true });
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  test("CODEX_HOME absent → sessionsRoot stays empty (today's default)", () => {
    const a = codex.New();
    a.bindLaunchEnv(["HOME=" + homedir()], "");
    expect(a.sessionsRoot).toBe("");
  });
});
