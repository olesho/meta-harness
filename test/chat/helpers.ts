// Shared test helpers for the chat-layer ports.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  Conversation,
  EventBus,
  resolveAdapter,
  type ConversationInit,
  type Options,
} from "../../src/chat/conversation.ts"
import { newMemStore } from "../../src/chat/memstore.ts"
import type { Session } from "../../src/chat/types.ts"
import type { Screen } from "../../src/screen/index.ts"
import type { InputRequest as TurnsInputRequest } from "../../src/turns/index.ts"

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Records every keystroke written through the injected writeStdin sink. */
export class KeyRecorder {
  data: Uint8Array = new Uint8Array(0)
  write = (p: Uint8Array): void => {
    const out = new Uint8Array(this.data.length + p.length)
    out.set(this.data, 0)
    out.set(p, this.data.length)
    this.data = out
  }
  text(): string {
    return dec.decode(this.data)
  }
}

/** A trust-prompt request mirroring the Go input_test fixture. */
export function trustRequest(): TurnsInputRequest {
  return {
    id: "req-1",
    kind: "trust_prompt",
    prompt: "Do you trust the files in this folder?",
    options: [
      { id: "1", alias: "proceed", label: "Yes, proceed", keys: enc.encode("1\r") },
      { id: "2", alias: "deny", label: "No, exit", keys: enc.encode("2\r") },
    ],
  }
}

/** Builds a Conversation with an injected key recorder, mirroring newTestConv. */
export function newTestConv(
  opts: Partial<Options>,
  rec: KeyRecorder,
  extra: Partial<ConversationInit> = {},
): Conversation {
  return new Conversation({
    opts,
    eventCh: new EventBus(8),
    writeStdin: rec.write,
    ...extra,
  })
}

/**
 * Builds a Conversation wired up far enough to drive maybeIdleComplete: a real
 * screen, the harness adapter, an in-memory store and a session to append to.
 */
export function newIdleTestConv(
  opts: Partial<Options> & { harness: string },
  rec: KeyRecorder,
  screen: Screen,
): Conversation {
  const store = newMemStore()
  const session: Session = {
    id: "sess-1",
    harness: opts.harness,
    workingDir: "",
    createdAt: new Date(),
    harnessSessionID: "",
  }
  void store.createSession(session)
  return newTestConv(opts, rec, {
    screen,
    store,
    adapter: resolveAdapter(opts.harness),
    session,
  })
}

/** One message entry of a fixture Codex rollout (a response_item line). */
export interface CodexRolloutEntry {
  role: "user" | "assistant"
  text: string
}

function rolloutMessageLine(entry: CodexRolloutEntry, n: number): string {
  return JSON.stringify({
    timestamp: `2026-06-26T05:25:24.${String(n % 1000).padStart(3, "0")}Z`,
    type: "response_item",
    payload: {
      type: "message",
      role: entry.role,
      content: [
        { type: entry.role === "user" ? "input_text" : "output_text", text: entry.text },
      ],
    },
  })
}

/**
 * writeCodexRollout lays a Codex session rollout fixture under sessionsRoot at
 * the real on-disk shape (<root>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl): a
 * session_meta envelope followed by one message response_item per entry.
 * Returns the file path so tests can appendCodexRollout later.
 */
export function writeCodexRollout(
  sessionsRoot: string,
  sessionID: string,
  cwd: string,
  entries: CodexRolloutEntry[] = [
    { role: "user", text: "hello codex" },
    { role: "assistant", text: "hi there" },
  ],
): string {
  const dir = join(sessionsRoot, "2026", "06", "26")
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({
      timestamp: "2026-06-26T05:25:23.303Z",
      type: "session_meta",
      payload: { session_id: sessionID, cwd, cli_version: "0.142.0" },
    }),
    ...entries.map((e, i) => rolloutMessageLine(e, i)),
  ]
  const file = join(dir, `rollout-2026-06-26T07-25-23-${sessionID}.jsonl`)
  writeFileSync(file, lines.join("\n") + "\n")
  return file
}

/** appendCodexRollout appends further message entries to an existing rollout. */
export function appendCodexRollout(file: string, entries: CodexRolloutEntry[]): void {
  appendFileSync(
    file,
    entries.map((e, i) => rolloutMessageLine(e, 40 + i)).join("\n") + "\n",
  )
}

export { enc, dec }
