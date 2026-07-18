// Port of pkg/chat/memstore/memstore_test.go.
import { describe, expect, test } from "vitest";
import { newMemStore } from "../../src/chat/memstore.ts";
import type { Session, Turn } from "../../src/chat/types.ts";

function mkSession(id: string): Session {
  return {
    id,
    harness: "codex",
    workingDir: "",
    createdAt: new Date(),
    harnessSessionID: "",
  };
}

function mkTurn(id: string, sessionID: string, text: string): Turn {
  return {
    id,
    sessionID,
    role: "user",
    state: "complete",
    text,
    reason: "",
    startedAt: new Date(),
    completedAt: new Date(),
    httpCode: 0,
    retryAfter: 0,
  };
}

describe("memstore", () => {
  test("create + get session round-trips", async () => {
    const s = newMemStore();
    await s.createSession(mkSession("sess-1"));
    const got = await s.getSession("sess-1");
    expect(got.id).toBe("sess-1");
  });

  test("duplicate createSession errors", async () => {
    const s = newMemStore();
    await s.createSession(mkSession("dup"));
    await expect(s.createSession(mkSession("dup"))).rejects.toThrow(
      /already exists/,
    );
  });

  test("getSession missing errors", async () => {
    const s = newMemStore();
    await expect(s.getSession("nope")).rejects.toThrow(/not found/);
  });

  test("updateSession backfills HarnessSessionID", async () => {
    const s = newMemStore();
    const sess = mkSession("s");
    await s.createSession(sess);
    sess.harnessSessionID = "harness-uuid";
    await s.updateSession(sess);
    const got = await s.getSession("s");
    expect(got.harnessSessionID).toBe("harness-uuid");
  });

  test("updateSession missing errors", async () => {
    const s = newMemStore();
    await expect(s.updateSession(mkSession("ghost"))).rejects.toThrow(
      /not found/,
    );
  });

  test("appendTurn preserves insertion order; listTurns returns copies", async () => {
    const s = newMemStore();
    await s.createSession(mkSession("s"));
    await s.appendTurn(mkTurn("t1", "s", "first"));
    await s.appendTurn(mkTurn("t2", "s", "second"));
    const turns = await s.listTurns("s");
    expect(turns.map((t) => t.id)).toEqual(["t1", "t2"]);

    // Mutating a returned copy does not affect the store.
    turns[0].text = "mutated";
    const again = await s.listTurns("s");
    expect(again[0].text).toBe("first");
  });

  test("appendTurn for unknown session errors", async () => {
    const s = newMemStore();
    await expect(s.appendTurn(mkTurn("t", "ghost", "x"))).rejects.toThrow(
      /not found/,
    );
  });

  test("updateTurn replaces in place; missing errors", async () => {
    const s = newMemStore();
    await s.createSession(mkSession("s"));
    await s.appendTurn(mkTurn("t1", "s", "v1"));
    const updated = mkTurn("t1", "s", "v2");
    await s.updateTurn(updated);
    const turns = await s.listTurns("s");
    expect(turns[0].text).toBe("v2");

    await expect(s.updateTurn(mkTurn("ghost", "s", "x"))).rejects.toThrow(
      /not found/,
    );
  });

  test("listTurns for a session with no turns returns empty", async () => {
    const s = newMemStore();
    await s.createSession(mkSession("s"));
    expect(await s.listTurns("s")).toEqual([]);
  });

  test("listTurns for unknown session errors", async () => {
    const s = newMemStore();
    await expect(s.listTurns("ghost")).rejects.toThrow(/not found/);
  });
});
