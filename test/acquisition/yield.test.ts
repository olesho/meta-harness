import { afterEach, describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  EnvHome,
  EnvHookCwd,
  EnvSpool,
  EnvYieldFile,
  YieldControl,
  checkYield,
  hookEnv,
} from "../../src/acquisition/internal/yield.ts";

const open: YieldControl[] = [];
function fresh(): YieldControl {
  const y = new YieldControl();
  open.push(y);
  return y;
}
afterEach(() => {
  for (const y of open.splice(0)) y.close();
});

describe("YieldControl", () => {
  test("request → checkYield → clear round-trip", () => {
    const y = fresh();
    // No file yet ⇒ no block.
    expect(checkYield(y.filePath()).block).toBe(false);

    y.request("supervisor cancelled");
    const outcome = checkYield(y.filePath());
    expect(outcome.block).toBe(true);
    const decision = JSON.parse(outcome.blockOutput) as {
      decision: string;
      reason: string;
    };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toBe(
      "Yield requested (supervisor cancelled) — please stop and exit immediately.",
    );

    y.clear();
    expect(checkYield(y.filePath()).block).toBe(false);
    // Clearing a nonexistent file is fine.
    expect(() => {
      y.clear();
    }).not.toThrow();
  });

  test("request writes atomically — no partial file, no stray temp files", () => {
    const y = fresh();
    y.request("first");
    y.request("second"); // overwrites

    const dir = path.dirname(y.filePath());
    const entries = readdirSync(dir);
    // Exactly the committed file — the temp file was renamed away.
    expect(entries).toEqual(["yield.json"]);

    const parsed = JSON.parse(readFileSync(y.filePath(), "utf8")) as {
      reason: string;
    };
    expect(parsed.reason).toBe("second");
  });

  test("checkYield on an empty path or missing file does not block", () => {
    expect(checkYield("").block).toBe(false);
    expect(checkYield("/no/such/yield/file.json").block).toBe(false);
  });

  test("close removes the yield file and temp dir, and is idempotent", () => {
    const y = new YieldControl();
    y.request("bye");
    const dir = path.dirname(y.filePath());
    expect(existsSync(dir)).toBe(true);
    y.close();
    expect(existsSync(dir)).toBe(false);
    expect(() => {
      y.close();
    }).not.toThrow();
  });
});

describe("hookEnv", () => {
  test("augments the base env with HW_* variables including the yield file", () => {
    const y = fresh();
    const base = ["EXISTING=1"];
    const env = hookEnv(base, "/spool/dir", "/work/tree", y);
    const map = envMap(env);

    expect(map.get("EXISTING")).toBe("1");
    expect(map.get(EnvSpool)).toBe("/spool/dir");
    expect(map.get(EnvHookCwd)).toBe("/work/tree");
    expect(map.get(EnvHome)).toBe(homedir());
    expect(map.get(EnvYieldFile)).toBe(y.filePath());
    // Base env is not mutated.
    expect(base).toEqual(["EXISTING=1"]);
  });

  test("omits HW_YIELD_FILE when no YieldControl is provided", () => {
    const env = hookEnv([], "/spool", "/cwd", null);
    const map = envMap(env);
    expect(map.has(EnvYieldFile)).toBe(false);
    expect(map.get(EnvSpool)).toBe("/spool");
    expect(map.get(EnvHookCwd)).toBe("/cwd");
  });

  test("materializes the process env when base is null", () => {
    const env = hookEnv(null, "/spool", "/cwd");
    const map = envMap(env);
    expect(map.get(EnvSpool)).toBe("/spool");
    expect(map.get("PATH")).toBe(process.env.PATH);
  });
});

// envMap builds a KEY→VALUE map, last write winning (mirrors env-array semantics).
function envMap(entries: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) {
    const eq = e.indexOf("=");
    if (eq < 0) continue;
    m.set(e.slice(0, eq), e.slice(eq + 1));
  }
  return m;
}
