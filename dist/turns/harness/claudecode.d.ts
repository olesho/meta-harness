import type { Snapshot } from "../../screen/index.ts";
import { GenericAdapter } from "../generic.ts";
import type { Adapter, Event, InputRequest, Turn } from "../types.ts";
/** Adapter implements turns.Adapter for Claude Code. */
export declare class ClaudeCodeAdapter extends GenericAdapter implements Adapter {
    /** Overrides ~/.claude/projects for the on-disk transcript reader. */
    projectsRoot: string;
    private lastFingerprint;
    private lastInterruptSeen;
    private lastInputID;
    private lastInput;
    name(): string;
    onScreen(snap: Snapshot): Event[];
    /** Implements turns.MessageExtractor. */
    extractMessage(snap: Snapshot): [string, boolean];
    /** Implements turns.BusyDetector. */
    busy(snap: Snapshot): boolean;
    /**
     * Implements turns.SwallowedPromptDetector. True when a settled screen shows
     * no trace of assistant activity for the in-flight turn: no "⏺" message
     * bullet (extractMessage fails) and either the screen is byte-identical to
     * the one the prompt was submitted on, or it carries no "✻ … for Ns"
     * thinking marker anywhere — i.e. Claude Code never accepted the prompt and
     * merely repainted its ready screen (observed live on 2.1.201).
     */
    promptNotAccepted(snap: Snapshot, sentScreenText: string): boolean;
    /** Implements turns.Quitter. */
    quitSequence(): Uint8Array;
    /** Implements turns.SessionInitializer — `claude --session-id <uuid>`. */
    initSession(): [string[], string];
    /** Implements turns.SessionResumer — `claude --resume <uuid>`. */
    resumeArgs(harnessSessionID: string): string[];
    /** Implements turns.SessionControlFlags — flags chat manages, banned from args. */
    sessionControlFlags(): string[];
    /** Implements turns.RawSessionIDExtractor. */
    extractSessionIDFromLine(line: string): [string, boolean];
    /** Implements turns.TranscriptReader — reads the on-disk Claude Code log. */
    readTranscript(harnessSessionID: string, workingDir: string): Turn[];
}
/** Constructs a Claude Code adapter. */
export declare function New(): ClaudeCodeAdapter;
/**
 * DetectInput recognizes a blocking interactive dialog in the rendered screen
 * text and returns the structured request, or null when none is present.
 */
export declare function DetectInput(text: string): InputRequest | null;
//# sourceMappingURL=claudecode.d.ts.map