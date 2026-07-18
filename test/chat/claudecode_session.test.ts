// Claude Code create-session support driven over the REAL fake-harness process.
// Since Claude Code 2.1.201 no longer prints the exit-time "claude --resume
// <uuid>" hint, chat mints the id at launch (`--session-id <uuid>`) exactly as
// it does for pi: Create seeds a minted --session-id, the store carries the id
// before any turn runs, and the conflict guard rejects raw session-control
// flags before launch. The raw-hint capture stays as a backstop for older
// builds and must not clobber the seeded id (first-write-wins).

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, isSentinel } from "../../src/internal/async/index.ts";
import {
  Open,
  ErrInvalidOptions,
  newMemStore,
  type Conversation,
} from "../../src/chat/index.ts";
import { New, fakeHarnessBin, openFake } from "./fakeharness.ts";

const open = new Set<Conversation>();
afterEach(async () => {
  for (const conv of open) {
    const { ctx } = Context.withDeadline(Context.background(), 2000);
    await conv.close(ctx);
  }
  open.clear();
});
function track(conv: Conversation): Conversation {
  open.add(conv);
  return conv;
}

function argvOutPath(): string {
  return join(mkdtempSync(join(tmpdir(), "cc-argv-")), "argv.json");
}

async function readArgv(path: string): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`argv dump never appeared at ${path}`);
}

const uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ccScript() {
  return New("claude-code").Idle().StayAliveUntilStopped().Build();
}

describe("claude-code create session", () => {
  test("Open (create) seeds a minted --session-id", async () => {
    const store = newMemStore();
    const argvPath = argvOutPath();
    const conv = track(
      await openFake(ccScript(), { store, argvOut: argvPath }),
    );
    const argv = await readArgv(argvPath);
    expect(argv[0]).toBe("--session-id");
    expect(argv[1]).toMatch(uuidRE);
    const stored = await store.getSession(conv.sessionID());
    expect(stored.harnessSessionID).toBe(argv[1]);
  });

  test("the fake's resume hint does not clobber the seeded id", async () => {
    // The claude-code Idle() frame paints "claude --resume <session_id>" with
    // the fake's own uuid — the backstop capture must lose to the seeded id.
    const store = newMemStore();
    const hintID = "abcd1234-0000-0000-0000-00000000cafe";
    const conv = track(
      await openFake(
        New("claude-code")
          .Session(hintID)
          .Idle()
          .StayAliveUntilStopped()
          .Build(),
        { store },
      ),
    );
    const stored = await store.getSession(conv.sessionID());
    expect(stored.harnessSessionID).toMatch(uuidRE);
    expect(stored.harnessSessionID).not.toBe(hintID);
  });

  describe("conflict guard rejects session-control flags before launch", () => {
    const cases: Record<string, string[]> = {
      "--resume": ["--resume", "x"],
      "short -r": ["-r"],
      "attached --session-id=": ["--session-id=abc"],
      "--fork-session": ["--fork-session"],
      "--continue": ["--continue"],
      "--no-session-persistence": ["--no-session-persistence"],
    };
    for (const [name, args] of Object.entries(cases)) {
      test(name, async () => {
        const p = Open(undefined, {
          harness: "claude-code",
          binaryPath: fakeHarnessBin,
          store: newMemStore(),
          args,
        });
        await expect(p).rejects.toThrow();
        await p.catch((err) => {
          expect(isSentinel(err, ErrInvalidOptions)).toBe(true);
        });
      });
    }

    test("positional after -- is not rejected", async () => {
      const argvPath = argvOutPath();
      const conv = track(
        await openFake(ccScript(), {
          store: newMemStore(),
          argvOut: argvPath,
          args: ["--", "--resume"],
        }),
      );
      const argv = await readArgv(argvPath);
      expect(argv).toContain("--");
      expect(argv).toContain("--resume");
      // create prefix still present.
      expect(argv[0]).toBe("--session-id");
    });
  });
});
