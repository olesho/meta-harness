import type { Snapshot } from "../../screen/index.ts";
import { GenericAdapter } from "../generic.ts";
import type { Adapter, Turn } from "../types.ts";
/** Adapter implements turns.Adapter for the pi coding agent. */
export declare class PiAdapter extends GenericAdapter implements Adapter {
    root: string;
    pinnedSessionsDir: string;
    name(): string;
    /**
     * Implements turns.StreamInterleaved. pi's stream-json is `pi -p --mode json`,
     * a headless print mode that SUPPRESSES the TUI (test/corpus/pi/README.md), so
     * it is not emitted interleaved with the interactive session pi runs under
     * here. Not Stream-eligible in A1 — no StreamParser.parseStreamLine is
     * implemented; the Stream branch is scaffolding lit up by a later interleaving
     * adapter.
     */
    streamInterleaved(): boolean;
    /**
     * Optional capability: chat calls this once at Open with the effective child
     * env AND cwd, so the reader resolves the same sessions dir the child was
     * launched with (see PI_CODING_AGENT_* precedence).
     */
    bindLaunchEnv(env: string[], workingDir: string): void;
    /** Implements turns.SessionInitializer — `pi --session-id <uuid>`. */
    initSession(): [string[], string];
    /** Implements turns.SessionResumer — `pi --session <uuid>`. */
    resumeArgs(id: string): string[];
    /** Implements turns.SessionControlFlags — flags chat manages, banned from args. */
    sessionControlFlags(): string[];
    /** Implements turns.TranscriptReader. Timestamp is forwarded as-is (may be undefined). */
    readTranscript(harnessSessionID: string, workingDir: string): Turn[];
    /** Implements turns.Quitter. */
    quitSequence(): Uint8Array;
    /** Implements turns.BusyDetector. */
    busy(snap: Snapshot): boolean;
}
/** Constructs a pi adapter. */
export declare function New(): PiAdapter;
/**
 * PromptReady reports whether pi's composer is initialized and idle — the status
 * line is painted and no turn is in flight.
 */
export declare function PromptReady(text: string): boolean;
//# sourceMappingURL=pi.d.ts.map