// Shared test helpers for the chat-layer ports.
import { Conversation, EventBus, type Options } from "../../src/chat/conversation.ts"
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
export function newTestConv(opts: Partial<Options>, rec: KeyRecorder): Conversation {
  return new Conversation({
    opts,
    eventCh: new EventBus(8),
    writeStdin: rec.write,
  })
}

export { enc, dec }
