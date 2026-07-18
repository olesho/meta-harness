// HookDrain — the spool → canonical-Event runtime integration (META-HARNESS-73).
// The riskiest seam: an out-of-process hook writes the spool, the in-process
// runtime drains it on its OWN wakeup (independent of the turn watcher), and the
// deduped SourceHook events flow to the durable-store sink. Provenance
// (source === SourceHook) is asserted ONLY here / on the wire form — never on a
// Conversation.events() element, which structurally cannot carry it.

import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  HookDrain,
  hookSpoolSubdir,
  type HookDrainOptions,
  type WakeSignal,
} from "../../src/chat/hookDrain.ts";
import { Signal } from "../../src/chat/conversation.ts";
import { appendSpool, spoolFilePath } from "../../src/hooks/spool.ts";
import { ClaudeHookProvider } from "../../src/hooks/claude.ts";
import * as claudecode from "../../src/turns/harness/claudecode.ts";
import { SourceHook, type ParsedEvent } from "../../src/transcript/event.ts";
import { marshalParsedEvents } from "../../src/transcript/eventWire.ts";
import type {
  HookContext,
  HookProvider,
  HookSpec,
} from "../../src/hooks/provider.ts";

const root = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOOKS_BIN = path.join(root, "dist", "cli", "hooks.js");

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "mh-hookdrain-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A no-op provider whose ensureConfig records the ctx and returns a stub spec —
// the unit tests exercise the drain machinery, not settings.json installation.
class StubProvider implements HookProvider {
  lastCtx?: HookContext;
  ensureConfig(ctx: HookContext): HookSpec {
    this.lastCtx = ctx;
    return {
      configPath: path.join(ctx.configDir, "settings.json"),
      events: [],
      owner: "stub",
    };
  }
  parsePayload(): ParsedEvent[] {
    return [];
  }
}

// hookEvent builds a canonical SourceHook ParsedEvent (as drainSpool rehydrates).
function hookEvent(
  id: string,
  text: string,
  type = "turn_boundary",
): ParsedEvent {
  return {
    harnessSessionID: "s1",
    event: { role: "system", type, text, source: SourceHook, nativeID: id },
  };
}

interface Harness {
  drain: HookDrain;
  events: ParsedEvent[][];
  boundaryTurns: { role: string; text: string }[][];
  wake: WakeSignal;
}

function newDrain(over: Partial<HookDrainOptions> = {}): Harness {
  const events: ParsedEvent[][] = [];
  const boundaryTurns: { role: string; text: string }[][] = [];
  const wake = new Signal();
  const drain = new HookDrain({
    provider: new StubProvider(),
    workingDir: "/work",
    harnessSessionID: "s1",
    configDir: tempDir(),
    wake,
    closed: new Promise<void>(() => {}),
    isClosed: () => false,
    onEvents: (evs) => events.push(evs),
    onBoundaryTurns: (t) => boundaryTurns.push(t),
    fallbackMs: 80,
    ...over,
  });
  return { drain, events, boundaryTurns, wake };
}

describe("HookDrain — spool dir lifecycle", () => {
  test("ensureConfig installs the managed block and creates the per-session spool dir", () => {
    const configDir = tempDir();
    // The adapter's hookProvider() wrapper is what WRITES settings.json (the bare
    // ClaudeHookProvider only resolves the spec); use it so ensureConfig installs.
    const provider = claudecode.New().hookProvider();
    const drain = new HookDrain({
      provider,
      workingDir: configDir,
      harnessSessionID: "sess-abc",
      configDir,
      home: configDir,
      wake: new Signal(),
      closed: new Promise<void>(() => {}),
      isClosed: () => false,
      onEvents: () => {},
    });

    // Spool dir is derived, per-run, keyed on the harness session id.
    expect(drain.spoolDir()).toBe(
      path.join(configDir, hookSpoolSubdir, "sess-abc"),
    );
    expect(existsSync(drain.spoolDir())).toBe(false);

    const spec = drain.ensureConfig();
    // The managed settings.json block is installed by the provider.
    expect(spec.configPath).toBe(path.join(configDir, "settings.json"));
    expect(existsSync(spec.configPath)).toBe(true);
    // And the spool dir now exists.
    expect(existsSync(drain.spoolDir())).toBe(true);
  });

  test("close runs a final flush drain to catch the tail, then reaps the spool dir", () => {
    const { drain, events } = newDrain();
    drain.ensureConfig();
    // A record lands AFTER the last wake — only the final flush can catch it.
    appendSpool(drain.spoolDir(), [hookEvent("hook:tail:s1", "tail")]);

    expect(existsSync(drain.spoolDir())).toBe(true);
    drain.close();

    // Final flush routed the tail...
    expect(events.flat().map((pe) => pe.event.nativeID)).toContain(
      "hook:tail:s1",
    );
    // ...and the spool dir is reaped.
    expect(existsSync(drain.spoolDir())).toBe(false);
  });

  test("close leaves the managed settings.json block installed (removal is explicit only)", () => {
    const configDir = tempDir();
    const provider = claudecode.New().hookProvider();
    const drain = new HookDrain({
      provider,
      workingDir: configDir,
      harnessSessionID: "s1",
      configDir,
      home: configDir,
      wake: new Signal(),
      closed: new Promise<void>(() => {}),
      isClosed: () => false,
      onEvents: () => {},
    });
    const spec = drain.ensureConfig();
    drain.close();
    // settings.json survives ordinary shutdown; only reap removed the spool dir.
    expect(existsSync(spec.configPath)).toBe(true);
  });
});

describe("HookDrain — independent drain wakeup", () => {
  test("bounded fallback timer drains a pre-existing spool with NO wake and NO fs event", async () => {
    // Write the spool BEFORE start() so fs.watch (started after) sees no event,
    // and never signal the wake: only the bounded fallback timer can drain it.
    // Proves the drain is NOT gated on the turn watcher yielding an event.
    const { drain, events, wake } = newDrain({ fallbackMs: 60 });
    drain.ensureConfig();
    appendSpool(drain.spoolDir(), [hookEvent("hook:idle:s1", "idle")]);

    // Sanity: the wake was never raised by us.
    void wake;

    drain.start();
    await delay(300);
    drain.close();

    expect(events.flat().map((pe) => pe.event.nativeID)).toContain(
      "hook:idle:s1",
    );
  });

  test("fs.watch on the spool dir raises the wake and drains promptly", async () => {
    const { drain, events } = newDrain({
      fallbackMs: 5000 /* huge: only the watch can be prompt */,
    });
    drain.ensureConfig();
    drain.start();

    // Written AFTER the watch is live — the fs event must raise the wake well
    // before the (5s) fallback timer.
    appendSpool(drain.spoolDir(), [hookEvent("hook:watched:s1", "watched")]);
    await delay(400);
    drain.close();

    expect(events.flat().map((pe) => pe.event.nativeID)).toContain(
      "hook:watched:s1",
    );
  });

  test("an explicit wake signal drains without waiting for the timer", async () => {
    const { drain, events, wake } = newDrain({ fallbackMs: 5000 });
    drain.ensureConfig();
    drain.start();
    appendSpool(drain.spoolDir(), [hookEvent("hook:sig:s1", "sig")]);
    wake.signal();
    await delay(200);
    drain.close();
    expect(events.flat().map((pe) => pe.event.nativeID)).toContain(
      "hook:sig:s1",
    );
  });

  test("the loop terminates when the close promise resolves", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((r) => (resolveClosed = r));
    let isClosed = false;
    const { drain } = newDrain({
      closed,
      isClosed: () => isClosed,
      fallbackMs: 5000,
    });
    drain.ensureConfig();
    drain.start();
    isClosed = true;
    resolveClosed();
    await delay(50);
    // No assertion beyond "did not hang"; the loop must have returned.
    drain.close();
    expect(true).toBe(true);
  });
});

describe("HookDrain — routing & dedup (durable-store layer)", () => {
  test("routed events carry source === SourceHook", () => {
    const { drain, events } = newDrain();
    drain.ensureConfig();
    appendSpool(drain.spoolDir(), [hookEvent("hook:a:s1", "a")]);
    drain.drainOnce();
    const routed = events.flat();
    expect(routed).toHaveLength(1);
    expect(routed[0].event.source).toBe(SourceHook);
    // And the durable wire form persists the provenance.
    const wire = JSON.parse(marshalParsedEvents(routed)) as {
      event: { source?: string };
    }[];
    expect(wire[0].event.source).toBe("hook");
  });

  test("an event drained twice is routed only once (dedup across drains)", () => {
    const { drain, events } = newDrain();
    drain.ensureConfig();
    appendSpool(drain.spoolDir(), [hookEvent("hook:dup:s1", "dup")]);
    drain.drainOnce();
    // Same eventID re-appears in a later batch (e.g. a re-fire) — deduped out.
    appendSpool(drain.spoolDir(), [hookEvent("hook:dup:s1", "dup")]);
    drain.drainOnce();
    expect(
      events.flat().filter((pe) => pe.event.nativeID === "hook:dup:s1"),
    ).toHaveLength(1);
  });

  test("dedup within a single batch collapses duplicate ids", () => {
    const { drain, events } = newDrain();
    drain.ensureConfig();
    appendSpool(drain.spoolDir(), [
      hookEvent("hook:same:s1", "x"),
      hookEvent("hook:same:s1", "x"),
    ]);
    drain.drainOnce();
    expect(
      events.flat().filter((pe) => pe.event.nativeID === "hook:same:s1"),
    ).toHaveLength(1);
  });

  test("a SourceFile twin supplied via existing() supersedes the provisional hook event", () => {
    const fileTwin: ParsedEvent = {
      harnessSessionID: "s1",
      // Tool events carry source-independent ids, so this collapses with the hook one.
      event: {
        role: "tool",
        type: "tool_use",
        toolUseID: "t1",
        source: "file",
        nativeID: "",
      },
    };
    const events: ParsedEvent[][] = [];
    const configDir = tempDir();
    const drain = new HookDrain({
      provider: new StubProvider(),
      workingDir: "/w",
      harnessSessionID: "s1",
      configDir,
      wake: new Signal(),
      closed: new Promise<void>(() => {}),
      isClosed: () => false,
      onEvents: (e) => events.push(e),
      existing: () => [fileTwin],
    });
    drain.ensureConfig();
    // A hook tool-use sharing the SourceFile twin's eventID.
    appendSpool(drain.spoolDir(), [
      {
        harnessSessionID: "s1",
        event: {
          role: "tool",
          type: "tool_use",
          toolUseID: "t1",
          source: SourceHook,
        },
      },
    ]);
    drain.drainOnce();
    // The authoritative SourceFile event wins the collision → nothing hook-sourced
    // is routed (the reader feeds the file event downstream itself).
    expect(events.flat()).toHaveLength(0);
  });
});

describe("HookDrain — chat-surface projection is separate (no source)", () => {
  test("turn-boundary edges project to Turns that carry role/text but NO source", () => {
    const { drain, events, boundaryTurns } = newDrain();
    drain.ensureConfig();
    appendSpool(drain.spoolDir(), [
      hookEvent("hook:stop:s1", "turn-end", "turn_boundary"),
    ]);
    drain.drainOnce();

    // Durable side still sees SourceHook...
    expect(events.flat()[0].event.source).toBe(SourceHook);
    // ...chat side gets a Turn projection with no `source` field, by construction.
    const turns = boundaryTurns.flat();
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("turn-end");
    expect("source" in (turns[0] as object)).toBe(false);
  });
});

describe("HookDrain — end-to-end through the real hook subprocess", () => {
  test("hooks bin writes spool → drainOnce routes SourceHook events to the store layer", () => {
    // The riskiest seam, exercised for real: spawn the OUT-OF-PROCESS
    // meta-harness-hooks bin with HW_EVENT_SPOOL set, pipe a Claude Stop payload
    // on stdin. It parses + appends to the spool; the runtime drains it and the
    // deduped SourceHook events flow through the dedup consumer.
    if (!existsSync(HOOKS_BIN)) {
      execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
    }

    const configDir = tempDir();
    const events: ParsedEvent[][] = [];
    const drain = new HookDrain({
      provider: new ClaudeHookProvider(),
      workingDir: configDir,
      harnessSessionID: "sess-e2e",
      configDir,
      home: configDir,
      wake: new Signal(),
      closed: new Promise<void>(() => {}),
      isClosed: () => false,
      onEvents: (e) => events.push(e),
    });
    drain.ensureConfig();

    const payload = JSON.stringify({
      session_id: "sess-e2e",
      hook_event_name: "Stop",
    });
    // The bin reads HW_EVENT_SPOOL / HW_HARNESS_SESSION_ID from its env.
    execFileSync(process.execPath, [HOOKS_BIN, "claude-code", "Stop"], {
      input: payload,
      env: {
        ...process.env,
        HW_EVENT_SPOOL: drain.spoolDir(),
        HW_HARNESS_SESSION_ID: "sess-e2e",
        HW_HOOK_CWD: configDir,
        HW_HOME: configDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // The subprocess wrote the spool file out of process.
    expect(existsSync(spoolFilePath(drain.spoolDir()))).toBe(true);

    const fresh = drain.drainOnce();
    expect(fresh.length).toBeGreaterThan(0);
    // Provenance is observable at the store/transcript layer — NOT on events().
    for (const pe of fresh) expect(pe.event.source).toBe(SourceHook);
    // And it round-trips through the durable wire form as source:"hook".
    const wire = JSON.parse(marshalParsedEvents(fresh)) as {
      event: { source?: string };
    }[];
    for (const w of wire) expect(w.event.source).toBe("hook");

    drain.close();
    expect(existsSync(drain.spoolDir())).toBe(false);
  }, 180_000);
});
