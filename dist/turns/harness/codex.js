// Turn-detection adapter for the Codex CLI (github.com/openai/codex).
//
// Legacy (≤0.141): every turn ended with a "Token usage:" footer — a per-turn
// fingerprint that drove TurnComplete. Codex 0.142+ removed that footer, so
// OnScreen stays silent on current Codex. The legacy path is kept for any codex
// still emitting the footer and is locked in by the corpus tests.
//
// Session-id capture is an own-output `/status` scrape: the chat layer primes
// the session at first idle by writing `/status`, which renders a box containing
// `│ Session: <uuid> │`; extractSessionID reads that (and the legacy / `/quit`
// `codex resume <uuid>` hint). Reading a process's own output cannot collide
// with another process, so the scrape is race-free by construction and remains
// PRIMARY.
//
// locateSessionID (disk fallback) is a GUARDED backstop for the case the scrape
// cannot cover — a Codex build that stops rendering the `│ Session: <uuid> │`
// box (and emits no `/quit` hint) yet still writes a `session_meta` rollout. The
// naive disk-locate that META-HARNESS-20 removed was racy: it captured the
// most-recently-modified rollout for a cwd, so a sibling/prior session sharing
// that cwd could be mis-captured. This fallback is re-introduced WITHOUT that
// race: the chat layer consults it only on the codex first-write path and only
// when the prime wrote `/status` but the box never yielded an id
// (primeOutcome === "written_uncaptured"), never during priming, and never on
// the provisional-refresh path. See src/chat/conversation.ts extractSessionID
// (the allowDiskFallback gate). The transcript reader (readTranscript /
// CodexReader) still reads disk, but that is keyed on an already-captured id and
// is a separate concern.
import { createHash } from "node:crypto";
import { CodexReader, turnsFromEvents } from "../../transcript/index.js";
import { GenericAdapter } from "../generic.js";
import { InputRequested, InputResolved, TurnComplete } from "../types.js";
import { StatusWaitingForInput } from "../wrapper.js";
const enc = new TextEncoder();
// tokenUsageRE matches the per-turn Token usage footer Codex printed on ≤0.141.
// Kept strict (anchored full footer) so it cannot false-fire on reply prose.
const tokenUsageRE = /Token usage: total=[\d,]+ input=[\d,]+ \(\+ [\d,]+ cached\) output=[\d,]+(?: \(reasoning \d+\))?/g;
// resumeRE matches the "codex resume <uuid>" hint — the legacy ≤0.141 footer AND
// the 0.142+ `/quit` / `/exit` hint ("To continue this session, run codex resume
// <uuid>"). Already-specific text, low spoof risk, so it is scanned ungated.
const resumeRE = /codex resume ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
const UUID_RE_SRC = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// statusSessionRE matches the `Session: <uuid>` row INSIDE the `/status` box,
// anchored on the vertical box borders (│ … │) on the SAME physical row. Only the
// rendered `/status` box draws those borders around the label, so this excludes a
// bare `Session: <uuid>` string appearing in reply prose. It assumes the row
// renders unwrapped on one screen line — see CODEX_STATUS_MIN_COLS.
const statusSessionRE = new RegExp("│[^\\S\\r\\n]*Session:[^\\S\\r\\n]+(" + UUID_RE_SRC + ")[^\\S\\r\\n]*│");
// statusBoxHeaderRE gates statusSessionRE on the Codex banner literal.
//
// What the literal actually does: `">_ OpenAI Codex (v"` is the codex STARTUP
// BANNER, not a `/status`-box-only string — test/corpus/auth/codex/
// normal-composer/screen.txt contains exactly one occurrence and NO `Session:` /
// `Permissions:` / `Collaboration mode:` row. So this gate establishes HARNESS
// IDENTITY ("this screen was painted by codex"), not box presence. The anti-spoof
// weight is carried by the `│ … │` row anchors in statusSessionRE above.
//
// Non-global on purpose: consumed via .test(), which would be lastIndex-stateful
// under /g. Same convention as every other regex in this file.
const statusBoxHeaderRE = />_ OpenAI Codex \(v/;
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
export const CODEX_STATUS_MIN_COLS = 60;
/** Adapter implements turns.Adapter for Codex CLI. */
export class CodexAdapter extends GenericAdapter {
    /** Overrides ~/.codex/sessions for the transcript reader (readTranscript). */
    sessionsRoot = "";
    lastFingerprint = "";
    lastInputID = "";
    lastInput = null;
    name() {
        return "codex";
    }
    /**
     * Implements turns.StreamInterleaved. Codex shows no interleaved stream-json
     * surface in-repo, so it is not Stream-eligible in A1 and does not implement
     * StreamParser.parseStreamLine. The Stream branch is scaffolding lit up by a
     * later interleaving adapter.
     */
    streamInterleaved() {
        return false;
    }
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
    onWrapperStatus(status, reason) {
        if (status === StatusWaitingForInput && this.lastInputID !== "")
            return [];
        return super.onWrapperStatus(status, reason);
    }
    onScreen(snap) {
        const out = [];
        // Turn-complete detection — newest Token usage footer differs from last.
        const matches = snap.text.match(tokenUsageRE);
        if (matches && matches.length > 0) {
            const latest = matches[matches.length - 1];
            if (latest !== this.lastFingerprint) {
                this.lastFingerprint = latest;
                out.push({ kind: TurnComplete, reason: "codex: " + latest });
            }
        }
        // Blocking startup interstitial — transition on the request ID.
        const req = DetectInput(snap.text);
        if (req) {
            if (req.id !== this.lastInputID) {
                // A different interstitial replaced the one we were tracking without an
                // intervening dialog-free frame (e.g. the update notice giving way to a
                // model-migration or notice screen). Resolve the previous one first so
                // every InputRequested is balanced by an InputResolved and the chat
                // layer's currentInput is not silently overwritten — which would drop
                // the prior request's identity/kind (a client subscribed from the start
                // would otherwise see the replacement's kind on the eventual resolve).
                if (this.lastInputID !== "") {
                    const prev = this.lastInput ?? {
                        id: this.lastInputID,
                        kind: "",
                        prompt: "",
                    };
                    out.push({
                        kind: InputResolved,
                        reason: "codex: input resolved",
                        input: prev,
                    });
                }
                this.lastInputID = req.id;
                this.lastInput = req;
                out.push({
                    kind: InputRequested,
                    reason: "codex: " + req.prompt,
                    input: req,
                });
            }
        }
        else if (this.lastInputID !== "") {
            const resolved = this.lastInput ?? {
                id: this.lastInputID,
                kind: "",
                prompt: "",
            };
            this.lastInputID = "";
            this.lastInput = null;
            out.push({
                kind: InputResolved,
                reason: "codex: input resolved",
                input: resolved,
            });
        }
        return out;
    }
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
    extractSessionID(snap) {
        const m = resumeRE.exec(snap.text);
        if (m)
            return [m[1], true];
        // The gate is named in this docstring and belongs with the other regexes at
        // the top of the file; inlining it as String#includes is what left
        // statusBoxHeaderRE dead. Behaviour-identical: same literal, no anchors, and
        // non-global so .test() carries no lastIndex state.
        // eslint-disable-next-line @typescript-eslint/prefer-includes
        if (statusBoxHeaderRE.test(snap.text)) {
            const s = statusSessionRE.exec(snap.text);
            if (s)
                return [s[1], true];
        }
        return ["", false];
    }
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
    locateSessionID(workingDir) {
        const id = new CodexReader(this.sessionsRoot).locateLatestSession(workingDir);
        return id ? [id, true] : ["", false];
    }
    /**
     * Implements turns.SessionIDPrimer — the keystrokes that make Codex print its
     * session id on screen: the `/status` slash command followed by the CSI 13 u
     * submit key (unmodified Enter under the kitty keyboard protocol; mirrors
     * submitKeyForHarness("codex") and the quit sequence's hardcoded submit).
     */
    primeSessionIDKeys() {
        return enc.encode("/status" + "\x1b[13u");
    }
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
    promptNotAccepted(snap, sentScreenText) {
        if (snap.text === sentScreenText)
            return true;
        const lines = snap.text.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
            const m = composerRowRE.exec(lines[i]);
            if (m)
                return m[1].trim() !== "";
        }
        return false;
    }
    /** Implements turns.SessionResumer — `codex resume <uuid>`. */
    resumeArgs(harnessSessionID) {
        return ["resume", harnessSessionID];
    }
    /**
     * Implements turns.SessionForkResumer. False: `codex resume <uuid>` continues
     * the same session id — VERIFIED against codex-cli 0.142.5 (2026-07-03): the
     * resume banner reports the same "session id: <uuid>" and the migrated rollout
     * envelope keeps the original session_id. Because the id is preserved on
     * resume, the chat layer must NOT arm its one-shot provisional id refresh.
     */
    resumeForksSessionID() {
        return false;
    }
    /** Implements turns.TranscriptReader. */
    readTranscript(harnessSessionID, workingDir) {
        const events = new CodexReader(this.sessionsRoot).read(harnessSessionID, workingDir);
        return turnsFromEvents(events).map((t) => ({
            role: t.role,
            text: t.text,
            timestamp: t.timestamp ?? new Date(0),
        }));
    }
}
/** Constructs a Codex adapter. */
export function New() {
    return new CodexAdapter();
}
// ── Interstitial detection (input.go) ────────────────────────────────────────
const updateAnchor = "Update available!";
const migrationAnchor = "Choose how you'd like Codex to proceed";
const continueAnchor = "Press enter to continue";
// signinWallRE identifies Codex's logged-out onboarding / sign-in screens. They
// render "Press enter to continue" too, but they are an AUTH WALL — a first-run
// sign-in wizard, not a dismissable interstitial. The chat layer's auth-required
// path (onboardingWall / authRequired in ready.ts) already holds them as
// not-ready and short-circuits Send. If DetectInput also classified them as a
// codex_notice, the adapter would surface a spurious input_request AND a bare
// Enter (KindNotice auto-dismiss) could pick the highlighted "Sign in with
// ChatGPT" row and kick off a real sign-in. So DetectInput excludes them.
// Anchors mirror codexOnboardingRE in ready.ts (kept in sync via
// test/corpus/auth).
const signinWallRE = /sign in with chatgpt|finish signing in via your browser/i;
// approvalAnchors are the full-sentence questions codex renders at the top of a
// genuine command / apply-patch approval dialog. Captured live from codex-cli
// 0.144.4 (test/corpus/codex/approval-command, approval-patch). Full sentences,
// not prose fragments, so the ready-side gate (src/chat/ready.ts) stays tight.
const approvalAnchors = [
    "Would you like to run the following command?",
    "Would you like to make the following edits?",
];
export const KindUpdateNotice = "codex_update_notice";
export const KindModelMigration = "codex_model_migration";
export const KindNotice = "codex_notice";
// KindApproval marks a genuine command / apply-patch approval prompt. This exact
// string is pinned by the chat contract fixture (test/chat/codex_dismiss.test.ts)
// and by orche's default handler contract — do not rename.
export const KindApproval = "approval_prompt";
// KindPermissions marks codex's /permissions "Update Model Permissions" picker.
// Like KindApproval this exact string is part of the client contract — pinned by
// test/chat/codex_dismiss.test.ts — do not rename.
export const KindPermissions = "permissions_prompt";
// permissionsAnchor is the /permissions dialog header (codex 0.144.x). Anchoring
// on the HEADER, not the footer: the footer ("Press enter to confirm or esc to
// go back") is assembled upstream from the template fragments " to confirm or " /
// " to go back" with key names injected, so it is not matchable as a literal.
const permissionsAnchor = "Update Model Permissions";
// menuRE matches a Codex numbered menu row. Group 1 captures the "›" highlight
// marker on the currently-selected row (undefined when absent); group 2 the
// digit; group 3 the label.
const menuRE = /^[^\S\r\n]*(›)?[^\S\r\n]*(\d+)\.[^\S\r\n]+(.+?)[^\S\r\n]*$/gm;
// promptRE matches the idle composer prompt indicator — the "›" glyph alone.
const promptRE = /^[^\S\r\n]*›/m;
// composerRowRE matches one "›"-prefixed screen row, capturing what follows the
// glyph. Applied per-line, last match wins (the composer sits below scrollback).
const composerRowRE = /^[^\S\r\n]*›(.*)$/;
/**
 * DetectInput recognizes a blocking startup interstitial in the rendered screen
 * text and returns the structured request, or null when none is present.
 */
export function DetectInput(text) {
    // KindApproval is checked FIRST — before updateAnchor / migration / continue —
    // for two safety reasons (both would otherwise mis-handle an approval dialog
    // whose body incidentally quotes an interstitial anchor):
    //   1. continueAnchor→KindNotice and migrationAnchor→KindModelMigration both
    //      AUTO-DISMISS with a bare "\r", which on an approval dialog would press
    //      Enter on the highlighted "Yes" — i.e. auto-approve. The approval footer
    //      is "Press enter to confirm or esc to cancel" (not "…continue"), so no
    //      real dialog collides today, but the ordering makes that guarantee
    //      independent of codex's exact footer wording.
    //   2. The updateAnchor branch `return null`s the whole function when its skip
    //      gate fails — an approval body mentioning "Update available!" would be
    //      swallowed to null, silently reviving the false-TurnComplete failure
    //      this detection exists to kill.
    const approval = detectApproval(text);
    if (approval)
        return approval;
    // The logged-out sign-in wall renders "Press enter to continue" but is an auth
    // wall handled by the auth-required path — never a dismissable interstitial
    // (see signinWallRE).
    if (signinWallRE.test(text))
        return null;
    // The /permissions picker is checked BEFORE updateAnchor / migration /
    // continue for the same reason KindApproval is (safety, not style): those
    // three branches auto-dismiss with a bare "\r" (see AutoDismissKeys), and
    // Enter on this dialog silently COMMITS the highlighted preset — which codex
    // persists globally to ~/.codex/config.toml. A permissions screen whose body
    // happens to quote an interstitial anchor must therefore classify as
    // permissions_prompt (never auto-dismissable), not as a notice.
    const permissions = detectPermissions(text);
    if (permissions)
        return permissions;
    if (text.includes(updateAnchor)) {
        const opts = parseMenuOptions(text);
        const req = {
            id: "",
            kind: KindUpdateNotice,
            prompt: updateAnchor,
            options: opts,
        };
        // Require a parsed "Skip" row to confirm this is the live update menu.
        if (findByAlias(req, "skip") === null)
            return null;
        req.id = inputID(req);
        return req;
    }
    if (text.includes(migrationAnchor)) {
        const req = {
            id: "",
            kind: KindModelMigration,
            prompt: migrationAnchor,
            options: continueOption(),
        };
        req.id = inputID(req);
        return req;
    }
    if (text.includes(continueAnchor)) {
        let opts = parseMenuOptions(text);
        if (opts.length === 0)
            opts = continueOption();
        const req = {
            id: "",
            kind: KindNotice,
            prompt: continueAnchor,
            options: opts,
        };
        req.id = inputID(req);
        return req;
    }
    return null;
}
/**
 * detectApproval recognizes a genuine command / apply-patch approval dialog and
 * returns the structured request, or null.
 *
 * The gate is MANDATORY-STRICT, not best-effort: once this surfaces, step-5's
 * onWrapperStatus override suppresses TurnComplete and ready.ts blocks sends, so
 * a false positive DEADLOCKS the turn (strictly worse than the false-complete it
 * replaces). Beyond the anchor it therefore requires ALL of:
 *   - a proceed-aliased parsed row,
 *   - a deny-aliased parsed row (mirrors the update dialog's skip-row gate), and
 *   - the "›" highlight marker on at least one PARSED menu row.
 *
 * The highlight is a per-row property (parseMenuOptions records it from menuRE's
 * marker group), NOT a screen-wide regex: scrollback prompt echoes render past
 * prompts as "› <text>" rows, so a user prompt that began with "1. " echoes as
 * "› 1. …" and a screen-wide scan would match it anywhere on screen — combined
 * with a quoted anchor and a proceed/deny-shaped enumeration the whole gate would
 * false-positive into a deadlocked turn.
 *
 * The per-row flag alone is NOT sufficient either, because parseMenuOptions reads
 * the WHOLE screen: an echo row is itself a parsed row, so `› 4. Deploy the thing`
 * above a prose spoof lends its highlight to the gate (digit dedup only saves the
 * case where the echo's digit collides with a real menu digit). So the rows are
 * parsed from the text AFTER the anchor — codex renders scrollback above the
 * dialog, so a past-prompt echo can never sit inside that tail. Verified against
 * the corpus: the live dialogs' menus follow their anchor, so this does not
 * perturb their parsed options or their inputID.
 *
 * Residual (accepted, documented): a highlighted numbered row rendered BELOW a
 * prose-quoted anchor — e.g. the user typing "4. something" into the composer
 * while such a reply is on screen — is still counted. Codex replaces the composer
 * with the dialog while a real approval is up, so this shape is contrived; the
 * ready-side gate (src/chat/ready.ts) is independent of it.
 */
function detectApproval(text) {
    const anchor = approvalAnchors.find((a) => text.includes(a));
    if (!anchor)
        return null;
    const tail = text.slice(text.indexOf(anchor) + anchor.length);
    const opts = parseMenuOptions(tail);
    const req = {
        id: "",
        kind: KindApproval,
        prompt: anchor,
        options: opts,
    };
    if (findByAlias(req, "proceed") === null)
        return null;
    if (findByAlias(req, "deny") === null)
        return null;
    if (!opts.some((o) => o.highlighted))
        return null;
    req.id = inputID(req);
    return req;
}
/**
 * detectPermissions recognizes codex's /permissions "Update Model Permissions"
 * dialog and returns the structured request, or null.
 *
 * Built on the detectApproval template, and strict for the same reason: once
 * this surfaces, onWrapperStatus suppresses TurnComplete and ready.ts blocks
 * sends, so a false positive deadlocks the turn. Beyond the header anchor it
 * requires a real menu — at least two parsed rows and a live "›" highlight —
 * and, as in detectApproval, parses rows from the text AFTER the anchor: codex
 * renders scrollback above the dialog, so a past-prompt echo rendered as
 * "› 1. …" can never sit inside that tail and lend a spurious highlight.
 *
 * Deliberately NOT gated on specific preset labels or on a row count of exactly
 * three: the rendered set varies by build and config (0.144.5 also ships
 * "Read Only" / "Default" / "Custom permissions" alongside "Ask for approval" /
 * "Approve for me" / "Full Access").
 *
 * The active preset's label carries a "(current)" suffix (cleanLabel splits at
 * the dialog's double-space column gutter, so it rides along in the label). That
 * is NOT the same thing as `highlighted`: the highlight is the cursor and moves
 * with the arrow keys, while "(current)" marks the preset already in effect.
 */
function detectPermissions(text) {
    const i = text.indexOf(permissionsAnchor);
    if (i < 0)
        return null;
    const opts = parseMenuOptions(text.slice(i + permissionsAnchor.length));
    // A live menu, not a quoted header: presets always come as a choice of ≥2.
    if (opts.length < 2)
        return null;
    // A live "›" selector on one of the parsed rows.
    if (!opts.some((o) => o.highlighted))
        return null;
    const req = {
        id: "",
        kind: KindPermissions,
        prompt: permissionsAnchor,
        options: opts,
    };
    req.id = inputID(req);
    return req;
}
/** Reports whether the idle composer prompt is on screen (gate behind DetectInput). */
export function PromptReady(text) {
    return promptRE.test(text);
}
/**
 * AutoDismissKeys returns the keystrokes that safely dismiss an interstitial
 * without triggering a destructive action, and whether it is auto-dismissable.
 */
export function AutoDismissKeys(req) {
    if (!req)
        return [null, false];
    switch (req.kind) {
        case KindUpdateNotice: {
            const o = findByAlias(req, "skip");
            if (o)
                return [o.keys, true];
            return [null, false];
        }
        case KindNotice:
            // A KindNotice is classified only when the screen shows the "Press enter
            // to continue" anchor and is neither an update notice nor a model
            // migration (both matched earlier in DetectInput with their own safe
            // dismissal). The one real Codex "Press enter to continue" screen that IS
            // an actionable menu — the logged-out sign-in wall — is excluded upstream
            // in DetectInput (signinWallRE) and never reaches here, so what remains is
            // an informational notice (e.g. the "What's new" / changelog screen). Enter
            // is the continuation codex advertises, so a bare CR clears it regardless
            // of how many numbered body lines parseMenuOptions extracted — the
            // multi-option notice that previously surfaced and blocked the codex
            // plan-critic on its first send. Genuine command-approval prompts are a
            // different kind and are never classified as KindNotice.
            return [enc.encode("\r"), true];
        case KindModelMigration:
            return [enc.encode("\r"), true];
        case KindPermissions:
            // Never auto-dismissable: Enter commits the highlighted preset to
            // ~/.codex/config.toml (global, and there is no "go back" option row).
            // The `default` branch would already return this — the explicit case is a
            // refactor guard so a future default change cannot make it dismissable.
            return [null, false];
        default:
            return [null, false];
    }
}
function continueOption() {
    return [
        {
            id: "continue",
            alias: "continue",
            label: "Continue",
            keys: enc.encode("\r"),
        },
    ];
}
function parseMenuOptions(text) {
    const opts = [];
    const seen = new Set();
    for (const m of text.matchAll(menuRE)) {
        const highlighted = m[1] !== undefined;
        const num = m[2];
        const label = cleanLabel(m[3]);
        // Dedup keeps the FIRST occurrence of a digit, so a scrollback echo that
        // collides with an already-parsed menu digit is dropped. Note this is NOT by
        // itself a defense against echoes lending a spurious "›" highlight to the
        // approval gate (a non-colliding digit survives) — detectApproval parses from
        // the anchor tail for that; see its comment.
        if (seen.has(num) || label === "")
            continue;
        seen.add(num);
        opts.push({
            id: num,
            alias: aliasForLabel(label),
            label,
            keys: enc.encode(num + "\r"),
            highlighted,
        });
    }
    return opts;
}
function cleanLabel(s) {
    const i = s.indexOf("  ");
    if (i >= 0)
        s = s.slice(0, i);
    return s.trim();
}
function aliasForLabel(label) {
    const l = label.toLowerCase();
    // Interstitial tokens first so classification of update / notice menus is
    // unchanged ("Skip" must not become deny-adjacent). Notice/menu option aliases
    // may shift (a "Continue" row now aliases "proceed" where it had ""), but
    // nothing downstream acts on notice option aliases.
    if (l.includes("skip"))
        return "skip";
    if (l.includes("update"))
        return "update";
    // Yes/No approval vocabulary, mirroring claudecode.ts aliasForLabel.
    if (containsAny(l, "proceed", "accept", "trust", "yes", "continue"))
        return "proceed";
    // The deny tokens are comma/space-suffixed ("no,", "no ") on purpose so they
    // never match "now"/"notice"; that leaves a bare "No" (lowercasing to exactly
    // "no") matching neither, so an exact-match case is added codex-side — the
    // approval gate REQUIRES a deny row, and real dialogs render a bare "2. No".
    if (l === "no")
        return "deny";
    if (containsAny(l, "exit", "deny", "reject", "cancel", "no,", "no ", "don't", "do not")) {
        return "deny";
    }
    return "";
}
function containsAny(s, ...subs) {
    return subs.some((sub) => s.includes(sub));
}
function findByAlias(req, alias) {
    for (const o of req.options ?? []) {
        if (o.alias === alias)
            return o;
    }
    return null;
}
function inputID(req) {
    const parts = [
        req.kind,
        req.prompt,
        ...(req.options ?? []).map((o) => o.label),
    ];
    const sum = createHash("sha256").update(parts.join("\0")).digest();
    return sum.subarray(0, 8).toString("hex");
}
//# sourceMappingURL=codex.js.map