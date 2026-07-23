import type { TranscriptTurn } from "../../chat/deps.ts";
import type { Snapshot } from "../../screen/index.ts";
import { GenericAdapter } from "../generic.ts";
import type { Adapter, Event, InputRequest, PermissionsDialogCapability } from "../types.ts";
import type { Status } from "../wrapper.ts";
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
export declare class CodexAdapter extends GenericAdapter implements Adapter, PermissionsDialogCapability {
    /** Overrides ~/.codex/sessions for the transcript reader (readTranscript). */
    sessionsRoot: string;
    /**
     * The CODEX_HOME this adapter's conversation was launched under, per
     * bindLaunchEnv: null until Open binds it, "" when bound but the variable is
     * absent from the effective launch env, else the raw (unresolved) parsed
     * value. permissionsWriteContained fails closed on either null or "" — see
     * that method for why an ambient/inherited CODEX_HOME can never satisfy it.
     */
    boundCodexHome: string | null;
    private lastFingerprint;
    private lastInputID;
    private lastInput;
    name(): string;
    /**
     * Implements turns.StreamInterleaved. Codex shows no interleaved stream-json
     * surface in-repo, so it is not Stream-eligible in A1 and does not implement
     * StreamParser.parseStreamLine. The Stream branch is scaffolding lit up by a
     * later interleaving adapter.
     */
    streamInterleaved(): boolean;
    /**
     * Suppresses the generic `waiting_for_input → TurnComplete` mapping while a
     * structured input request is on screen (lastInputID !== ""). The
     * InputRequested event already represents that state; letting the generic
     * mapping complete the turn mid-dialog is the false-TurnComplete bug this task
     * fixes — the consumer would find no task_complete in the rollout and treat
     * the reply as errored while the approval dialog is still up. The turn resumes
     * (InputResolved, then the real completion) once the dialog clears.
     *
     * Scope: lastInputID is also set while an auto-dismissed interstitial is still
     * clearing (the chat layer wrote the dismiss keys but the next dialog-free
     * onScreen has not yet fired). Suppressing TurnComplete there too is intended —
     * a turn must not complete while ANY structured dialog is on screen.
     *
     * All other statuses (Blocked / Errored / Idle / …) delegate to super even
     * mid-dialog: a crash during a dialog must still error the turn.
     */
    onWrapperStatus(status: Status, reason: string): Event[];
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
     * Implements turns.SessionIDLocator — the GUARDED disk fallback for a Codex
     * build whose `/status` scrape yields no id but which still writes a
     * `session_meta` rollout. Delegates through CodexReader (NOT the bare
     * locateLatestSession): the bare function reads this.sessionsRoot, which is ""
     * in production, so walkJSONL("") → readdirSync("") throws → undefined — a
     * silent no-op. CodexReader.resolveRoot() defaults to ~/.codex/sessions,
     * mirroring the readTranscript delegation below.
     *
     * locateLatestSession never throws (every fs call is try/catch) and returns
     * undefined for empty workingDir or no match, satisfying the [id, boolean]
     * contract. The chat layer gates WHEN this is consulted (only on the codex
     * first-write path once the prime recorded `written_uncaptured`), so this
     * method itself stays a plain latest-rollout lookup.
     */
    locateSessionID(workingDir: string): [string, boolean];
    /**
     * Implements turns.SessionIDPrimer — the keystrokes that make Codex print its
     * session id on screen: the `/status` slash command followed by the CSI 13 u
     * submit key (unmodified Enter under the kitty keyboard protocol; mirrors
     * submitKeyForHarness("codex") and the quit sequence's hardcoded submit).
     */
    primeSessionIDKeys(): Uint8Array;
    /**
     * Implements PermissionsDialogCapability.permissionsDialogKeys — opens the
     * `/permissions` "Update Model Permissions" picker: the slash command
     * followed by the CSI 13 u submit key.
     *
     * CAPTURED LIVE against codex-cli 0.144.5 (test/corpus/codex/
     * probe-backout-keys and probe-commit-keys-permissions, META-HARNESS-122):
     * every probe session opened the dialog by typing `/permissions` then
     * writing `\x1b[13u` as a single burst — the same free-text-composer submit
     * primeSessionIDKeys uses for `/status` above, not the bare-CR encoding that
     * (per the commit-key matrix probe) menu-ROW selection tolerates.
     */
    permissionsDialogKeys(): Uint8Array;
    /**
     * Implements PermissionsDialogCapability.dialogBackoutKeys — dismisses the
     * `/permissions` dialog WITHOUT committing a preset (esc, not enter).
     *
     * CAPTURED LIVE against codex-cli 0.144.5 (test/corpus/codex/
     * probe-backout-keys, META-HARNESS-122): both a bare ESC and CSI 27 u
     * dismissed the dialog cleanly with no composer residue; bare ESC (the
     * simpler encoding, and what a physical Esc key sends) is pinned. NOTE: a
     * bare ESC is a byte-for-byte PREFIX of CSI 13 u / CSI 27 u — a caller
     * distinguishing "was this an ESC key" from "was this a CSI-u sequence" must
     * match the exact one-byte string, not just "starts with 0x1b" (see the
     * probe's non-overlap note).
     */
    dialogBackoutKeys(): Uint8Array;
    /**
     * Implements PermissionsDialogCapability.composerClearKeys — empties a
     * composer already holding literal, unsubmitted text.
     *
     * CAPTURED LIVE against codex-cli 0.144.5 (test/corpus/codex/
     * probe-composer-clear-keys, META-HARNESS-122): Ctrl-U, Ctrl-A+Ctrl-K, and a
     * backspace run all cleared the composer back to the idle placeholder;
     * Ctrl-U is pinned as the shortest reliable encoding — one write regardless
     * of how much text is typed, unlike a backspace run whose length must scale
     * with it.
     */
    composerClearKeys(): Uint8Array;
    /**
     * Implements PermissionsDialogCapability.composerHasText — reports whether
     * the composer (the last "›" row on screen) still carries typed text.
     * Delegates to the same last-"›"-row scan promptNotAccepted uses, extracted
     * to lastComposerRowText so both methods share one regex and one loop.
     */
    composerHasText(snap: Snapshot): boolean;
    /**
     * Implements PermissionsDialogCapability.permissionsWriteContained — the
     * containment predicate gating a `/permissions` preset commit, which codex
     * persists to `$CODEX_HOME/config.toml` (global if CODEX_HOME is unset).
     * True only when:
     *   1. boundCodexHome was actually bound (not null — bindLaunchEnv never ran,
     *      e.g. a predicate consulted before Open) and not "" (bound, but the
     *      launch env carried no CODEX_HOME at all);
     *   2. resolve(boundCodexHome) === resolve(declaredHome) — the caller must
     *      NAME the same isolated home the conversation actually launched under;
     *      an ambient/inherited CODEX_HOME that happens to match by coincidence
     *      still satisfies this, which is why (3) exists; and
     *   3. that resolved path is not the real `~/.codex` — so even a caller who
     *      launched with no isolation and then "declares" their own real home
     *      cannot talk their way past the gate.
     * resolve() is applied to both sides so `~`, relative, and trailing-slash
     * spellings of the same directory compare equal.
     */
    permissionsWriteContained(declaredHome: string): boolean;
    /**
     * Optional capability (mirrors PiAdapter.bindLaunchEnv, src/turns/harness/
     * pi.ts): chat calls this once at Open (and again on Reopen, since the call
     * sits inside openWithSession) with the effective child env, so this adapter
     * learns the CODEX_HOME the harness process actually launched under.
     *
     * LAYERING ASYMMETRY vs. pi's use of the same shape: pi's bindLaunchEnv binds
     * a LOCATOR (where to read pi's session log from) — an inherited env value is
     * fine there, since at worst a wrong locator just fails to find a transcript.
     * Here the bound value feeds a SECURITY PREDICATE (permissionsWriteContained)
     * — a strictly stronger claim. That is why an inherited/ambient CODEX_HOME
     * can never be enough on its own: the caller must separately DECLARE the same
     * isolated home to permissionsWriteContained, and the two must agree.
     *
     * The `this.sessionsRoot === ""` guard is load-bearing: CodexReader.
     * resolveRoot() (src/transcript/codex/codex.ts) honours an explicitly-set
     * sessionsRoot over its own CODEX_HOME rung, and test/chat/
     * codex_swallow_override.test.ts / test/chat/codex_transcript_history.test.ts
     * both assign sessionsRoot AFTER Open — this must not clobber that.
     */
    bindLaunchEnv(env: string[], _workingDir: string): void;
    private lastComposerRowText;
    /**
     * Implements turns.PermissionModeCycler — one Shift+Tab press advances
     * Codex's collaboration mode by exactly one rung.
     *
     * The measured ring is a 2-cycle (Default ⇄ Plan), surfaced as a `Plan mode`
     * marker on the right of the composer status line and as the
     * `Collaboration mode: <name>` row of the `/status` box. Deliberately NOT
     * encoded here — as on Claude Code, callers terminate by lap detection with a
     * flat backstop, never by a hardcoded ring length.
     */
    permissionCycleKeys(): Uint8Array;
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
export declare const KindApproval = "approval_prompt";
export declare const KindPermissions = "permissions_prompt";
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