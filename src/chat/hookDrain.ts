// HookDrain — the spool → canonical-Event runtime integration (the riskiest
// seam of the hooks feature). It lives on the transcript durable-store /
// eventWire layer, NOT on Conversation.events(): a hook-sourced Event stamped
// SourceHook cannot survive onto the chat surface (ConversationEvent has no
// `source` field, and turnsFromEvents drops source/nativeID at the Turn
// boundary), so provenance is observable ONLY here.
//
// What it owns, end-to-end:
//   1. Independent drain wakeup. A dedicated loop Promise.races an in-process
//      wake Signal against the close promise and a BOUNDED fallback timer, so a
//      missed wake can never wedge the tail (a SessionStart-before-any-file-
//      change, or an idle-period Stop, still drains within `fallbackMs`). The
//      drain is NOT gated on the turn watcher yielding a foreign-source event.
//   2. Spool watch. Hook events arrive OUT OF PROCESS (a spawned
//      meta-harness-hooks writes the spool file), so the in-process wake Signal
//      is raised by a lightweight fs.watch on the spool dir. Where fs.watch is
//      unreliable/unsupported, the bounded fallback timer is the backstop.
//   3. SpoolDir lifecycle. The spool dir lives under the harness config/state
//      dir, a per-run subdirectory keyed on the tracked harnessSessionID.
//      ensureConfig() installs the managed settings.json block and creates the
//      dir; close() runs a FINAL flush drain to catch the tail, then reaps the
//      dir. Managed settings.json blocks are LEFT installed on ordinary
//      shutdown (idempotent, re-ensured each session) — removal is only via the
//      explicit removeManagedHooks path, never here.
//   4. Routing. Drained events go strictly to the durable-store/dedup layer
//      (onEvents, after mergeHookEvents). A lifecycle edge that also needs
//      chat-surface visibility is projected SEPARATELY via turnsFromEvents into
//      Turns (onBoundaryTurns) — and on that projection `source` is, by
//      construction, not observable.

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { drainSpool } from "../hooks/spool.ts";
import type { HookContext, HookProvider, HookSpec } from "../hooks/provider.ts";
import { mergeHookEvents } from "../transcript/hookMerge.ts";
import { EventTurnBoundary } from "../hooks/claude.ts";
import {
  eventID,
  turnsFromEvents,
  type ParsedEvent,
  type Turn,
} from "../transcript/event.ts";

// hookSpoolSubdir is the fixed segment under the harness config dir that holds
// the per-session spool directories. A per-run subdir keyed on the harness
// session id isolates concurrent sessions sharing one config dir.
export const hookSpoolSubdir = "hook-spool";

// defaultDrainFallbackMs bounds how long a missed wake Signal can delay a drain.
// It is a BACKSTOP, not the primary wake path (fs.watch raises the Signal
// promptly); small enough that SessionStart/idle hooks are never arbitrarily
// late, large enough not to busy-loop.
export const defaultDrainFallbackMs = 750;

// WakeSignal is the minimal shape HookDrain needs from the coalesced wake
// primitive — structurally satisfied by chat's Signal (conversation.ts). The
// drain loop receives() it; the fs.watch and the caller signal() it.
export interface WakeSignal {
  signal(): void;
  receive(): Promise<void>;
}

// HookDrainOptions wires a HookDrain to its harness provider, its wake Signal,
// its close signal, and its sinks.
export interface HookDrainOptions {
  /** The harness HookProvider (from the adapter's HookProviderCapability). */
  provider: HookProvider;
  /** Harness working dir (HookContext.cwd; also HW_HOOK_CWD for the hook CLI). */
  workingDir: string;
  /** Tracked harness session id — keys the per-run spool subdir and the guard. */
  harnessSessionID: string;
  /**
   * The harness config/state dir the spool dir is derived from (HookContext
   * .configDir). Empty ⇒ default to ~/.claude, matching the Claude provider's
   * own settings-path default.
   */
  configDir?: string;
  /** User home (HookContext.home). Empty ⇒ os.homedir(). */
  home?: string;
  /** In-process coalesced wake Signal the fs-watch raises; the loop receives it. */
  wake: WakeSignal;
  /** Resolves when the owning Conversation closes — unblocks the drain loop. */
  closed: Promise<void>;
  /** Whether the owner has closed (checked before every drain iteration). */
  isClosed: () => boolean;
  /**
   * The durable-store/dedup sink. Receives freshly-drained, deduped hook events
   * (source === SourceHook) — the shape that flows onto marshalParsedEvents.
   */
  onEvents: (events: ParsedEvent[]) => void;
  /**
   * Optional chat-surface projection of turn-boundary lifecycle edges. Boundary
   * events are projected via turnsFromEvents to Turns (which carry NO source),
   * keeping provenance off the chat surface by construction.
   */
  onBoundaryTurns?: (turns: Turn[]) => void;
  /**
   * SourceFile events already known to the reader, supplied so the dedup
   * consumer can collapse a provisional SourceHook event against its
   * authoritative SourceFile twin. Absent ⇒ () => [] (hook-only dedup).
   */
  existing?: () => ParsedEvent[];
  /** Bounded fallback timer (ms). Defaults to defaultDrainFallbackMs. */
  fallbackMs?: number;
}

/** Coalescing window for fs.watch raises, so a Linux inotify burst on the spool
 * dir wakes the drain loop once (macrotask-paced) instead of spinning it. */
const WATCH_DEBOUNCE_MS = 5;

/**
 * HookDrain runs the spool → canonical-Event integration for one Conversation.
 * Construct it, call ensureConfig() (installs the managed hooks + creates the
 * spool dir), wire spoolDir() into the harness launch env (HW_EVENT_SPOOL),
 * start() the loop, and close() on teardown.
 */
export class HookDrain {
  private readonly o: HookDrainOptions;
  private readonly _spoolDir: string;
  private readonly configDir: string;
  private readonly home: string;
  private readonly fallbackMs: number;

  /** eventIDs already routed to onEvents — dedup across successive drains. */
  private readonly emitted = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;

  constructor(o: HookDrainOptions) {
    this.o = o;
    this.home = o.home && o.home !== "" ? o.home : homedir();
    this.configDir =
      o.configDir && o.configDir !== ""
        ? o.configDir
        : path.join(this.home, ".claude");
    // Per-run spool dir keyed on the tracked harness session id. A missing id
    // (never expected for a hook-capable harness, which pins its id at launch)
    // degrades to a shared "_" bucket rather than colliding at the parent.
    const key = o.harnessSessionID !== "" ? o.harnessSessionID : "_";
    this._spoolDir = path.join(this.configDir, hookSpoolSubdir, key);
    this.fallbackMs =
      o.fallbackMs && o.fallbackMs > 0 ? o.fallbackMs : defaultDrainFallbackMs;
  }

  /** The per-run spool dir — wire this into the launch env as HW_EVENT_SPOOL. */
  spoolDir(): string {
    return this._spoolDir;
  }

  /** The HookContext the runtime and the out-of-process hook CLI both key off. */
  hookContext(): HookContext {
    return {
      cwd: this.o.workingDir,
      home: this.home,
      configDir: this.configDir,
      spoolDir: this._spoolDir,
      harnessSessionID: this.o.harnessSessionID,
    };
  }

  /**
   * ensureConfig installs/rewrites the managed settings.json hook block (via the
   * provider — idempotent, co-tenant-safe) and creates the spool dir. Returns
   * the resolved HookSpec. Call once before launch.
   */
  ensureConfig(): HookSpec {
    const spec = this.o.provider.ensureConfig(this.hookContext());
    fs.mkdirSync(this._spoolDir, { recursive: true, mode: 0o700 });
    return spec;
  }

  /**
   * start begins the fs-watch (raises the wake Signal on spool writes) and the
   * drain loop. Idempotent; a no-op after close().
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.startWatch();
    void this.loop();
  }

  /**
   * close runs a FINAL flush drain to catch the tail (a Stop/idle hook that
   * landed after the last wake), stops the watch, and reaps the spool dir. It
   * does NOT remove the managed settings.json block — that is left installed for
   * the next session and torn down only via the explicit removeManagedHooks path.
   */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopWatch();
    // Final flush BEFORE reap — the last records must not be lost to teardown.
    try {
      this.drainOnce();
    } catch {
      /* a drain fault must never wedge close */
    }
    try {
      fs.rmSync(this._spoolDir, { recursive: true, force: true });
    } catch {
      /* best-effort reap */
    }
  }

  /**
   * drainOnce reads+truncates the spool, routes freshly-seen deduped hook events
   * to onEvents, and projects turn-boundary edges to onBoundaryTurns. Safe to
   * call directly (tests, final flush). Returns the fresh events routed.
   */
  drainOnce(): ParsedEvent[] {
    const batch = drainSpool(this._spoolDir);
    if (batch.length === 0) return [];

    // Run the drained hook batch through the eventID-based dedup consumer,
    // collapsing a provisional SourceHook event against its authoritative
    // SourceFile twin (existing()) and ordering by seq/timestamp. With no
    // reader events supplied this still dedups WITHIN the hook batch.
    const existing = this.o.existing ? this.o.existing() : [];
    const merged = mergeHookEvents(existing, batch);

    const fresh: ParsedEvent[] = [];
    for (const pe of merged) {
      // Only hook-sourced events are ours to route; a SourceFile event that
      // came in via existing() is the reader's and is fed downstream elsewhere.
      if (pe.event.source !== "hook") continue;
      const id = eventID(pe.event);
      if (this.emitted.has(id)) continue;
      this.emitted.add(id);
      fresh.push(pe);
    }
    if (fresh.length === 0) return [];

    this.o.onEvents(fresh);

    // Chat-surface projection (deliverable 4): turn-boundary lifecycle edges are
    // projected SEPARATELY to Turns. turnsFromEvents keeps only role/text/
    // timestamp, so `source` is structurally absent on this surface.
    if (this.o.onBoundaryTurns) {
      const boundary = fresh
        .filter((pe) => pe.event.type === EventTurnBoundary)
        .map((pe) => pe.event);
      if (boundary.length > 0) {
        const turns = turnsFromEvents(boundary);
        if (turns.length > 0) this.o.onBoundaryTurns(turns);
      }
    }
    return fresh;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private startWatch(): void {
    try {
      // fs.watch on the dir fires on spool file create/append. Any event raises
      // the coalesced wake Signal; the loop drains once per wake. On platforms
      // where fs.watch is unreliable this may miss events — the bounded fallback
      // timer is the backstop, so correctness never depends on the watch.
      //
      // Debounce the raise: on Linux, fs.watch can fire a burst (or continuously)
      // for the drain's own spool-dir churn. Signalling per raw event would spin
      // the drain loop on a microtask treadmill that starves the event loop. A
      // short setTimeout coalesces a burst into one macrotask-paced wake.
      this.watcher = fs.watch(this._spoolDir, () => {
        if (this.watchDebounce) return;
        this.watchDebounce = setTimeout(() => {
          this.watchDebounce = null;
          this.o.wake.signal();
        }, WATCH_DEBOUNCE_MS);
      });
      this.watcher.on("error", () => {
        this.stopWatch();
      });
    } catch {
      // Watch unsupported here — the fallback timer covers draining entirely.
      this.watcher = null;
    }
  }

  private stopWatch(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  private async loop(): Promise<void> {
    // Wake the loop once when the Conversation closes so it re-checks
    // isClosed() and exits promptly. The previous code did
    // `this.o.closed.then(...)` inside a Promise.race EVERY iteration; race never
    // releases its losing arms, so each iteration leaked a handler on the
    // long-lived `closed` promise (and an abandoned wake/timer promise). When the
    // wake fires rapidly — e.g. fs.watch churn on Linux — the loop spins and
    // those pending promises accumulate until the worker runs out of heap.
    void this.o.closed.then(() => {
      this.o.wake.signal();
    });

    for (;;) {
      if (this.stopped || this.o.isClosed()) return;
      await this.waitWake();
      if (this.stopped || this.o.isClosed()) return;
      try {
        this.drainOnce();
      } catch {
        // A drain fault (corrupt spool, transient IO) must never kill the loop;
        // the next wake/timer retries.
      }
    }
  }

  /**
   * Wait for the next wake signal or the fallback timer. Every arm settles or is
   * cleared exactly once, so nothing accumulates across iterations even when the
   * wake fires continuously (fs.watch churn on Linux previously spun this loop
   * and leaked pending promises until the worker OOM'd).
   */
  private waitWake(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, this.fallbackMs);
      void this.o.wake.receive().then(finish, finish);
    });
  }
}
