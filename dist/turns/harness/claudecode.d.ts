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
 * Startup dialogs (trust/bypass) win over question dialogs; the two cannot
 * render simultaneously.
 */
export declare function DetectInput(text: string): InputRequest | null;
/**
 * DetectQuestion recognizes the AskUserQuestion dialog Claude Code renders
 * when the model asks the user a clarifying question mid-turn (verified live
 * against 2.1.210). Two panes exist:
 *
 *   - a QUESTION pane (kind "question"): tab-strip line, question text,
 *     numbered options, "Enter to select ·…" footer. Digit keys select an
 *     option directly (single-select) or toggle its checkbox (multi-select).
 *   - a REVIEW pane (kind "question_review"): after the last question of a
 *     multi-question or multi-select dialog — an answers summary plus a
 *     "Ready to submit your answers?" Submit/Cancel menu, no select footer.
 *
 * Returns null when neither pane is fully rendered. While either pane is up
 * the harness is idle-but-not-ready: no busy marker, no end-of-turn marker,
 * no empty composer — without this detection the turn would hang silently.
 */
export declare function DetectQuestion(text: string): InputRequest | null;
//# sourceMappingURL=claudecode.d.ts.map