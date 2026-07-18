// CodexAdapter.readTranscript wired into Conversation.historyWithSource:
// a Codex session with a non-empty harnessSessionID returns the rollout's turns
// sourced from the on-disk transcript (HistorySourceTranscript).
import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../../src/chat/conversation.ts";
import { writeCodexRollout } from "./helpers.ts";
import { newMemStore } from "../../src/chat/memstore.ts";
import { newScreen } from "../../src/screen/index.ts";
import { codex } from "../../src/turns/index.ts";
import {
  HistorySourceTranscript,
  RoleAssistant,
  RoleUser,
  type Session,
} from "../../src/chat/types.ts";

const tmps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "codex-hist-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("codex transcript history", () => {
  test("historyWithSource returns rollout turns from HistorySourceTranscript", async () => {
    const cwd = tempDir();
    const sessionsRoot = tempDir();
    const uuid = "019f0300-cdb9-7013-a43a-4eb1f65d94f1";
    writeCodexRollout(sessionsRoot, uuid, cwd);

    const adapter = codex.New();
    adapter.sessionsRoot = sessionsRoot;

    const store = newMemStore();
    const sess: Session = {
      id: "chat-hist-codex",
      harness: "codex",
      workingDir: "",
      createdAt: new Date(),
      harnessSessionID: uuid,
    };
    await store.createSession(sess);

    const c = new Conversation({
      opts: { harness: "codex", workingDir: cwd },
      adapter,
      screen: newScreen(120, 40),
      store,
      session: { ...sess },
    });

    const [turns, source] = await c.historyWithSource();
    expect(source).toBe(HistorySourceTranscript);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      [RoleUser, "hello codex"],
      [RoleAssistant, "hi there"],
    ]);
  });
});
