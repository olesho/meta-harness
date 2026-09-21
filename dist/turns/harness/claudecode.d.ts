import type { Snapshot } from "../../screen/index.ts";
import { type HookProvider } from "../../hooks/index.ts";
import { GenericAdapter } from "../generic.ts";
import type { Adapter, Event, InputRequest, Turn } from "../types.ts";
/**
 * Input kinds this adapter stamps on InputRequest.kind. They are the keys a
 * declarative policy matches on (chat's InputPolicy.byKind), so they are
 * exported: a consumer that wants to answer one screen and refuse the other
 * should name these constants rather than repeat the string literals.
 *
 * KindTrustPrompt is the folder-trust dialog, in either phrasing.
 */
export declare const KindTrustPrompt = "trust_prompt";
/**
 * KindBypassAcceptance is the --dangerously-skip-permissions acceptance
 * screen. Split out of KindTrustPrompt so a policy can trust a folder without
 * also accepting a skip-all-permissions launch. Twin of harness-wrapper's
 * claudecode.KindBypassAcceptance (PUPPET-507).
 */
export declare const KindBypassAcceptance = "bypass_acceptance";
/** Adapter implements turns.Adapter for Claude Code. */
export declare class ClaudeCodeAdapter extends GenericAdapter implements Adapter {
    /** Overrides ~/.claude/projects for the on-disk transcript reader. */
    projectsRoot: string;
    /**
     * Absolute path to the Node binary the installed hook commands launch under.
     * Empty means "resolve at ensure time" (defaults to process.execPath). Set by
     * tests (or a packaging layer) to pin a specific interpreter.
     */
    nodePath: string;
    /**
     * Absolute path to the committed `dist` directory holding `cli/hooks.js`, the
     * hook entrypoint. Empty means "resolve relative to this module". Set by tests
     * to point at a fixture dist.
     */
    distDir: string;
    private lastFingerprint;
    private lastInterruptSeen;
    private lastInputID;
    private lastInput;
    /**
     * Dedups the unrecognized-dialog Errored event across redraws of the SAME
     * unreadable dialog. Cleared whenever the screen leaves that state, so a later
     * recurrence (a second untrusted repo in one session) still reports.
     */
    private lastUnparseableFingerprint;
    name(): string;
    /**
     * Implements turns.StreamInterleaved. Claude Code drives the interactive TUI
     * exclusively and exposes no interleaved stream-json surface, so it is not
     * Stream-eligible in A1 and does not implement StreamParser.parseStreamLine.
     * The Stream branch is scaffolding lit up by a later interleaving adapter.
     */
    streamInterleaved(): boolean;
    onScreen(snap: Snapshot): Event[];
    /**
     * unparseableEvents reports a blocking dialog whose choices this build cannot
     * read: one Errored naming the anchor and the raw candidate lines, deduped on
     * a fingerprint of both so a redraw does not spam it.
     *
     * Two things it deliberately does NOT do. It never synthesizes an
     * InputResolved, and never touches lastInputID/lastInput: no InputRequested
     * was emitted for this screen, so there is no transition to close. (The
     * `else if (this.lastInputID !== "")` branch above still runs and correctly
     * resolves a PREVIOUSLY emitted request that has now vanished — that is a
     * different screen and stays untouched.)
     *
     * And it is a belt, not the primary signal: non-Input events are dropped while
     * no turn is in flight, so at startup — exactly when the folder-trust dialog
     * fires — this may go nowhere. src/chat/ready.ts is what keeps the send path
     * safe, and it does so anchor-only, without consulting this state at all.
     */
    private unparseableEvents;
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
    /**
     * Implements turns.PermissionModeCycler — one Shift+Tab press advances the
     * permission-mode ring by exactly one rung.
     *
     * The measured ring is 4 long launched normally (auto → manual → accept edits
     * → plan → auto) and 5 when launched with a bypass-enabling flag, where
     * `bypass permissions` joins it. Deliberately NOT encoded here: no code may
     * depend on either number, so callers terminate by lap detection with a flat
     * backstop. The measurement lives in the fixture notes as corroboration only.
     */
    permissionCycleKeys(): Uint8Array;
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
    /**
     * Implements turns.HookProviderCapability. Returns a HookProvider that:
     *   - ensureConfig: resolves the Claude static hook spec (from provider-parse)
     *     and installs/rewrites it in settings.json using the config-install
     *     primitives — idempotent and co-tenant-safe under the O_EXCL lock.
     *   - parsePayload: delegates to the Claude provider's payload parser.
     * Only the Claude adapter implements this; codex/opencode/pi/generic omit it.
     */
    hookProvider(): HookProvider;
}
/** Constructs a Claude Code adapter. */
export declare function New(): ClaudeCodeAdapter;
/**
 * Detection is what DetectInputDetail saw. The four states exist because a
 * single nullable return conflated two very different screens: "no dialog" and
 * "a dialog whose choices this build cannot read". The second one is PERMANENT —
 * it never clears on its own — so reporting it as the first left the harness
 * blocked with nothing naming the cause (claude 2.1.251's unnumbered
 * folder-trust dialog; see menuSelector.ts).
 *
 * Modelled as a string union with exported constants, following the codex
 * adapter's exported-string-constant idiom rather than a TS `enum`.
 */
export type Detection = "none" | "pending" | "unparseable" | "ok";
/** DetectNone: no dialog anchor on screen. */
export declare const DetectNone: Detection;
/**
 * DetectPending: the anchor is up but nothing choice-shaped has painted yet — a
 * mid-render frame. Not actionable, and deliberately silent.
 */
export declare const DetectPending: Detection;
/**
 * DetectUnparseable: the anchor is up AND choice-shaped lines are present, but
 * no usable option set could be built. Blocking and permanent; callers must fail
 * loudly rather than wait.
 */
export declare const DetectUnparseable: Detection;
/** DetectOK: a usable request was built. */
export declare const DetectOK: Detection;
/**
 * DetectInput recognizes a blocking interactive dialog in the rendered screen
 * text and returns the structured request, or null when no usable request could
 * be built. Startup dialogs (trust/bypass) win over question dialogs; the two
 * cannot render simultaneously.
 *
 * It is the nullable wrapper over DetectInputDetail kept for callers that only
 * need "can I answer this?" (src/oneshot, the adapter's InputRequested path).
 *
 * Callers that must distinguish "no dialog" (DetectNone / DetectPending) from
 * "a dialog I cannot read" (DetectUnparseable) must use DetectInputDetail
 * instead: this form maps every non-ok state to null.
 *
 * The startup dialogs carry TWO distinct kinds: the folder-trust dialog (either
 * phrasing) is KindTrustPrompt, and the --dangerously-skip-permissions
 * acceptance screen is KindBypassAcceptance.
 */
export declare function DetectInput(text: string): InputRequest | null;
/**
 * DetectInputDetail recognizes a blocking interactive dialog in the rendered
 * screen text and reports which of the four Detection states it is in.
 *
 * Note the asymmetry with the Go original: src/chat/ready.ts still does NOT
 * consume this — its claudeBlockingDialog is anchor-only, so it already treats all
 * four states as not-ready without parsing anything, and it stays turns-free by
 * that file's stated convention. The consumer is instead
 * Conversation.claudeDialogState (src/chat/conversation.ts), which sits beside its
 * only caller: the send path arms a stabilizer on DetectUnparseable and, when the
 * state survives a re-check of the live screen after the dwell, fast-fails with
 * chat.ErrUnrecognizedDialog rather than waiting out the send deadline. Go reaches
 * the same behaviour from pkg/chat/ready.go, whose file has no such convention;
 * only the file the helper sits in differs.
 */
export declare function DetectInputDetail(text: string): [InputRequest | null, Detection];
/**
 * DetectQuestionDetail recognizes the AskUserQuestion dialog and reports which
 * of the four Detection states the frame is in. DetectQuestion is the nullable
 * wrapper over it, kept source-compatible for callers that only need "can I
 * answer this?".
 *
 * The states exist here for the same reason they exist on the startup path
 * (see Detection): a question pane whose anchor is up but whose rows do not
 * parse is a PERMANENT blocking state, and reporting it as "no dialog" leaves
 * the turn hanging with nothing naming the cause.
 *
 * On claude 2.1.251 the rows are still numbered and this never fires
 * (PUPPET-301 verified live; see test/corpus/claude-code/question-single). It
 * is defence in depth against a build that drops the digits the way 2.1.251's
 * folder-trust dialog did — see menuSelector.ts.
 */
export declare function DetectQuestionDetail(text: string): [InputRequest | null, Detection];
/**
 * DetectQuestion recognizes the AskUserQuestion dialog Claude Code renders
 * when the model asks the user a clarifying question mid-turn (re-verified
 * live against 2.1.251 — PUPPET-301 — against the corpus recordings
 * test/corpus/claude-code/question-{single,multi,review}). Two panes exist:
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