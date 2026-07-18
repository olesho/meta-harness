import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  atomicWriteFileSync,
  ensureSettingsJSONHooks,
  isManagedHookCommand,
  removeManagedHooks,
  renderHookCommand,
  withLockedFile,
  type ManagedHooks,
  type SettingsHookMatcher,
} from "../../src/hooks/index.ts";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "mh-hooks-"));
}

const nodePath = "/usr/local/bin/node";
const distDir = "/opt/meta-harness/dist";

function managedFor(event: string, matcher = "*"): ManagedHooks {
  return {
    [event]: [
      {
        matcher,
        hooks: [
          {
            type: "command",
            command: renderHookCommand({ nodePath, distDir, event }),
          },
        ],
      },
    ],
  };
}

// A co-tenant block that must survive every ensure/remove — models e.g. a Go
// harness-wrapper's own hook entry, which lacks our marker.
const coTenant: SettingsHookMatcher = {
  matcher: "*",
  hooks: [
    { type: "command", command: "/opt/other-harness/wrap.sh # other-harness" },
  ],
};

describe("renderHookCommand / marker recognition", () => {
  test("pins node + committed dist/cli/hooks.js and tags the entry", () => {
    const cmd = renderHookCommand({ nodePath, distDir, event: "SessionStart" });
    expect(cmd).toContain(`"${nodePath}"`);
    expect(cmd).toContain(`"${path.join(distDir, "cli", "hooks.js")}"`);
    expect(cmd).toContain("SessionStart");
    expect(isManagedHookCommand(cmd)).toBe(true);
  });

  test("does not recognise a co-tenant command as managed", () => {
    expect(isManagedHookCommand(coTenant.hooks[0].command)).toBe(false);
  });
});

describe("ensureSettingsJSONHooks", () => {
  test("creates the managed block on a missing file", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    ensureSettingsJSONHooks(cfg, managedFor("Stop"));

    const settings = JSON.parse(readFileSync(cfg, "utf8"));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(isManagedHookCommand(settings.hooks.Stop[0].hooks[0].command)).toBe(
      true,
    );
    // Lock + tmp are cleaned up.
    expect(existsSync(`${cfg}.lock`)).toBe(false);
    expect(existsSync(`${cfg}.tmp`)).toBe(false);
  });

  test("is idempotent: repeated ensure yields exactly one managed block", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    for (let i = 0; i < 5; i++)
      ensureSettingsJSONHooks(cfg, managedFor("Stop"));

    const settings = JSON.parse(readFileSync(cfg, "utf8"));
    const managed = settings.hooks.Stop.filter((m: SettingsHookMatcher) =>
      m.hooks.some((h) => isManagedHookCommand(h.command)),
    );
    expect(managed).toHaveLength(1);
  });

  test("preserves a co-tenant block across ensure", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    // Seed the file with a co-tenant block already present.
    writeFileSync(
      cfg,
      JSON.stringify({ hooks: { Stop: [coTenant] } }, null, 2),
    );

    ensureSettingsJSONHooks(cfg, managedFor("Stop"));
    ensureSettingsJSONHooks(cfg, managedFor("Stop"));

    const settings = JSON.parse(readFileSync(cfg, "utf8"));
    const cmds = settings.hooks.Stop.flatMap((m: SettingsHookMatcher) =>
      m.hooks.map((h) => h.command),
    );
    // Exactly one managed + the untouched co-tenant.
    expect(cmds.filter(isManagedHookCommand)).toHaveLength(1);
    expect(cmds).toContain(coTenant.hooks[0].command);
  });

  test("preserves unrelated top-level settings keys", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    writeFileSync(
      cfg,
      JSON.stringify({ model: "opus", permissions: { x: 1 } }),
    );

    ensureSettingsJSONHooks(cfg, managedFor("Stop"));

    const settings = JSON.parse(readFileSync(cfg, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ x: 1 });
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  test("many sequential ensures never corrupt JSON (single block)", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ hooks: { Stop: [coTenant] } }));

    for (let i = 0; i < 25; i++) {
      ensureSettingsJSONHooks(cfg, managedFor("Stop"));
      // Every intermediate state parses cleanly (atomic rename guarantee).
      const s = JSON.parse(readFileSync(cfg, "utf8"));
      const managed = s.hooks.Stop.flatMap(
        (m: SettingsHookMatcher) => m.hooks,
      ).filter((h: { command: string }) => isManagedHookCommand(h.command));
      expect(managed).toHaveLength(1);
    }
  });
});

describe("removeManagedHooks", () => {
  test("strips the managed block but keeps the co-tenant", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    writeFileSync(cfg, JSON.stringify({ hooks: { Stop: [coTenant] } }));
    ensureSettingsJSONHooks(cfg, managedFor("Stop"));

    removeManagedHooks(cfg);

    const settings = JSON.parse(readFileSync(cfg, "utf8"));
    const cmds = settings.hooks.Stop.flatMap((m: SettingsHookMatcher) =>
      m.hooks.map((h) => h.command),
    );
    expect(cmds.some(isManagedHookCommand)).toBe(false);
    expect(cmds).toContain(coTenant.hooks[0].command);
  });

  test("drops the hooks key entirely when only our block existed", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    ensureSettingsJSONHooks(cfg, managedFor("Stop"));

    removeManagedHooks(cfg);

    const settings = JSON.parse(readFileSync(cfg, "utf8"));
    expect(settings.hooks).toBeUndefined();
  });
});

// True multi-process contention: N Node processes hammer ensure on one config.
// Requires native TS execution (Node >=22), so it is skipped on older runtimes —
// the in-process suite above covers the same guarantees deterministically.
const nodeMajor = Number(process.versions.node.split(".")[0]);
const here = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

describe.skipIf(nodeMajor < 22)(
  "ensureSettingsJSONHooks under real parallelism",
  () => {
    test("8 concurrent writers leave exactly one managed block, co-tenant intact", async () => {
      const dir = tempDir();
      const cfg = path.join(dir, "settings.json");
      writeFileSync(cfg, JSON.stringify({ hooks: { Stop: [coTenant] } }));

      const worker = path.join(here, "contend-worker.mjs");
      const modulePath = path.resolve(here, "../../src/hooks/index.ts");
      await Promise.all(
        Array.from({ length: 8 }, () =>
          execFileAsync(process.execPath, [worker, modulePath, cfg, "20"]),
        ),
      );

      const settings = JSON.parse(readFileSync(cfg, "utf8"));
      const cmds = settings.hooks.Stop.flatMap((m: SettingsHookMatcher) =>
        m.hooks.map((h) => h.command),
      );
      expect(cmds.filter(isManagedHookCommand)).toHaveLength(1);
      expect(cmds).toContain(coTenant.hooks[0].command);
      // No leaked lock/tmp after the storm.
      expect(existsSync(`${cfg}.lock`)).toBe(false);
      expect(existsSync(`${cfg}.tmp`)).toBe(false);
    });
  },
);

describe("withLockedFile / atomicWriteFileSync", () => {
  test("serialises the region and cleans up the sentinel", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    const seen: string[] = [];
    withLockedFile(cfg, () => {
      // Sentinel exists while held.
      expect(existsSync(`${cfg}.lock`)).toBe(true);
      seen.push("body");
      atomicWriteFileSync(cfg, JSON.stringify({ ok: true }));
    });
    expect(seen).toEqual(["body"]);
    expect(existsSync(`${cfg}.lock`)).toBe(false);
    expect(existsSync(`${cfg}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({ ok: true });
  });

  test("a held (fresh) lock blocks a second acquirer until it times out", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    // Manually plant a fresh sentinel — as if a peer holds it.
    writeFileSync(`${cfg}.lock`, "999999 held", { flag: "wx" });
    expect(() =>
      withLockedFile(cfg, () => "never", { acquireTimeoutMs: 100 }),
    ).toThrow(/timed out/);
  });

  test("reclaims a stale lock and proceeds", () => {
    const dir = tempDir();
    const cfg = path.join(dir, "settings.json");
    const lock = `${cfg}.lock`;
    writeFileSync(lock, "1 stale", { flag: "wx" });
    // Backdate the sentinel well past the stale TTL.
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);

    const result = withLockedFile(cfg, () => "reclaimed");
    expect(result).toBe("reclaimed");
    expect(existsSync(lock)).toBe(false);
  });
});
