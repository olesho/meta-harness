import type { HookContext, HookProvider, HookSpec } from "../hooks/provider.ts";
import { type ParsedEvent, type Turn } from "../transcript/event.ts";
export declare const hookSpoolSubdir = "hook-spool";
export declare const defaultDrainFallbackMs = 750;
export interface WakeSignal {
    signal(): void;
    receive(): Promise<void>;
}
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
/**
 * HookDrain runs the spool → canonical-Event integration for one Conversation.
 * Construct it, call ensureConfig() (installs the managed hooks + creates the
 * spool dir), wire spoolDir() into the harness launch env (HW_EVENT_SPOOL),
 * start() the loop, and close() on teardown.
 */
export declare class HookDrain {
    private readonly o;
    private readonly _spoolDir;
    private readonly configDir;
    private readonly home;
    private readonly fallbackMs;
    /** eventIDs already routed to onEvents — dedup across successive drains. */
    private readonly emitted;
    private watcher;
    private started;
    private stopped;
    constructor(o: HookDrainOptions);
    /** The per-run spool dir — wire this into the launch env as HW_EVENT_SPOOL. */
    spoolDir(): string;
    /** The HookContext the runtime and the out-of-process hook CLI both key off. */
    hookContext(): HookContext;
    /**
     * ensureConfig installs/rewrites the managed settings.json hook block (via the
     * provider — idempotent, co-tenant-safe) and creates the spool dir. Returns
     * the resolved HookSpec. Call once before launch.
     */
    ensureConfig(): HookSpec;
    /**
     * start begins the fs-watch (raises the wake Signal on spool writes) and the
     * drain loop. Idempotent; a no-op after close().
     */
    start(): void;
    /**
     * close runs a FINAL flush drain to catch the tail (a Stop/idle hook that
     * landed after the last wake), stops the watch, and reaps the spool dir. It
     * does NOT remove the managed settings.json block — that is left installed for
     * the next session and torn down only via the explicit removeManagedHooks path.
     */
    close(): void;
    /**
     * drainOnce reads+truncates the spool, routes freshly-seen deduped hook events
     * to onEvents, and projects turn-boundary edges to onBoundaryTurns. Safe to
     * call directly (tests, final flush). Returns the fresh events routed.
     */
    drainOnce(): ParsedEvent[];
    private startWatch;
    private stopWatch;
    private loop;
    /**
     * Wait for the next wake signal or the fallback timer. Every arm settles or is
     * cleared exactly once, so nothing accumulates across iterations even when the
     * wake fires continuously (fs.watch churn on Linux previously spun this loop
     * and leaked pending promises until the worker OOM'd).
     */
    private waitWake;
}
//# sourceMappingURL=hookDrain.d.ts.map