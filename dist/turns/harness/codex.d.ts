import type { TranscriptTurn } from "../../chat/deps.ts";
import type { Snapshot } from "../../screen/index.ts";
import { GenericAdapter } from "../generic.ts";
import type { Adapter, Event, InputRequest } from "../types.ts";
/**
 * CODEX_STATUS_MIN_COLS is the minimum terminal width at which the `/status` box
 * renders the `│ Session: <uuid> │` row unwrapped on a single line. The UUID (36
 * chars) plus the "Session: " label, the two `│` borders, and box padding needs
 * ~50 columns; the observed real 0.142.5 `/status` box is wider still, so the
 * primer requires at least this many columns before writing `/status`. Below it
 * the row wraps and the scrape silently fails, so the primer skips the write
 * (records a `too_narrow` outcome) and leaves the `/quit` hint as the backstop.
 * Set from the observed box width during the manual smoke.
 */
export declare const CODEX_STATUS_MIN_COLS = 60;
/** Adapter implements turns.Adapter for Codex CLI. */
export declare class CodexAdapter extends GenericAdapter implements Adapter {
    /** Overrides ~/.codex/sessions for the transcript reader (readTranscript). */
    sessionsRoot: string;
    private lastFingerprint;
    private lastInputID;
    private lastInput;
    name(): string;
    onScreen(snap: Snapshot): Event[];
    /**
     * Implements turns.SessionIDExtractor — an own-output screen scrape.
     *
     * Two signals, tried in order:
     *   1. resumeRE — the `codex resume <uuid>` hint (legacy footer AND the 0.142+
     *      `/quit` hint). Already specific text, scanned ungated.
     *   2. statusSessionRE — the `│ Session: <uuid> │` row inside the `/status`
     *      box. Gated on statusBoxHeaderRE so a lone spoofed box row cannot match.
     *
     * Called on arbitrary later snapshots too (the TurnComplete path), so the
     * status match is border-anchored AND header-gated to avoid mis-capturing a
     * `Session: <uuid>`-shaped string in reply prose.
     */
    extractSessionID(snap: Snapshot): [string, boolean];
    /**
     * Implements turns.SessionIDPrimer — the keystrokes that make Codex print its
     * session id on screen: the `/status` slash command followed by the CSI 13 u
     * submit key (unmodified Enter under the kitty keyboard protocol; mirrors
     * submitKeyForHarness("codex") and the quit sequence's hardcoded submit).
     */
    primeSessionIDKeys(): Uint8Array;
    /**
     * Implements turns.SwallowedPromptDetector. On codex 0.142.5 a swallowed
     * submit (the text+Enter burst consumed as a paste) leaves the prompt text
     * sitting in the composer with the Enter rendered as a newline — shape
     * captured live during the META-HARNESS-21 triage. Two signals:
     *   1. The settled screen is byte-identical to the one the prompt was
     *      submitted on (nothing was accepted at all).
     *   2. The LAST "›" row on screen — the composer; scrollback echoes of past
     *      prompts render above it — still carries text. An idle codex that
     *      actually ran the turn settles with an EMPTY "› " composer.
     */
    promptNotAccepted(snap: Snapshot, sentScreenText: string): boolean;
    /** Implements turns.SessionResumer — `codex resume <uuid>`. */
    resumeArgs(harnessSessionID: string): string[];
    /**
     * Implements turns.SessionForkResumer. False: `codex resume <uuid>` continues
     * the same session id — VERIFIED against codex-cli 0.142.5 (2026-07-03): the
     * resume banner reports the same "session id: <uuid>" and the migrated rollout
     * envelope keeps the original session_id. Because the id is preserved on
     * resume, the chat layer must NOT arm its one-shot provisional id refresh.
     */
    resumeForksSessionID(): boolean;
    /** Implements turns.TranscriptReader. */
    readTranscript(harnessSessionID: string, workingDir: string): TranscriptTurn[];
}
/** Constructs a Codex adapter. */
export declare function New(): CodexAdapter;
export declare const KindUpdateNotice = "codex_update_notice";
export declare const KindModelMigration = "codex_model_migration";
export declare const KindNotice = "codex_notice";
/**
 * DetectInput recognizes a blocking startup interstitial in the rendered screen
 * text and returns the structured request, or null when none is present.
 */
export declare function DetectInput(text: string): InputRequest | null;
/** Reports whether the idle composer prompt is on screen (gate behind DetectInput). */
export declare function PromptReady(text: string): boolean;
/**
 * AutoDismissKeys returns the keystrokes that safely dismiss an interstitial
 * without triggering a destructive action, and whether it is auto-dismissable.
 */
export declare function AutoDismissKeys(req: InputRequest | null): [Uint8Array | null, boolean];
//# sourceMappingURL=codex.d.ts.map