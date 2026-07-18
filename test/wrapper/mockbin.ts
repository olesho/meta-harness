// Shared test harness for the PTY-supervision tests: the path to the mock
// harness binary, an stdout-capturing sink, and a recording trace emitter.

import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StdoutSink } from "../../src/wrapper/index.ts";
import type { Event, Emitter } from "../../src/wrapper/trace.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the executable mock harness (node shebang). */
export const mockHarnessBin: string = join(here, "mock.mjs");

// Belt-and-suspenders: ensure the executable bit survives a fresh checkout.
try {
  chmodSync(mockHarnessBin, 0o755);
} catch {
  /* best effort */
}

/** A captured stdout sink plus a drain() that returns everything written. */
export function captureStdout(): { sink: StdoutSink; drain: () => string } {
  const chunks: Uint8Array[] = [];
  const sink: StdoutSink = {
    write(data: Uint8Array) {
      chunks.push(data.slice());
    },
  };
  const drain = () => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(merged);
  };
  return { sink, drain };
}

/** A trace.Emitter that records every event for later assertions. */
export class RecordingEmitter implements Emitter {
  readonly events: Event[] = [];
  emit(e: Event): void {
    this.events.push(e);
  }
  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}
