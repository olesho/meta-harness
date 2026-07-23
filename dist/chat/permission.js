// Pure, synchronous permission-mode parsing: given a rendered harness screen
// (a Screen.snapshot().text), report which rung of the 5-rung permission ladder
// the live session is on.
//
// This is the read side of the permission story. It follows parseModelPicker's
// shape (src/discovery/models.ts): pure, header/glyph-gated per harness, and
// returning null for an unsupported harness or a screen that is not gated in.
// There is NO live driver here — the caller (Conversation.permissionMode())
// owns polling the screen and completing the reading.
//
// The parser lives on the CHAT side deliberately. The existing module edge is
// one-way — src/discovery/models.ts imports ../chat/index.ts, and src/chat/**
// imports nothing from src/discovery/. Homing the parser in src/discovery/ and
// calling it from the Conversation would reverse that and risk a real ESM cycle
// (chat/index → conversation → discovery/index → models → chat/index), which
// would also drag discovery/index.ts's `import "./probes.ts"` side effect into
// every chat consumer. src/discovery/permission.ts is a re-export shim so the
// `./discovery` public subpath still resolves.
// ── claude-code: footer scrape ────────────────────────────────────────────
//
// The five real footers, captured live from 2.1.217:
//
//   ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
//   ⏸ manual mode on · ← for agents
//   ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents
//   ⏸ plan mode on (shift+tab to cycle) · ← for agents
//   ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
//
// `manual` is the ONLY one WITHOUT the "(shift+tab to cycle)" suffix, and it is
// claude's current DEFAULT — a regex requiring that suffix silently fails to see
// the most common mode. So these match the STRUCTURAL shape (glyph + "<words>
// on") rather than a word list: a renamed mode degrades to "unknown" + raw
// rather than to a wrong answer.
//
// Anti-spoof discipline (this is a safety-relevant read):
//   - Line-anchored /m with the [^\S\r\n] horizontal-whitespace class, the shape
//     claudeUsageLimitRE uses (src/chat/ready.ts), so a \n can never be eaten.
//   - The leading ⏵⏵ / ⏸ glyph is REQUIRED, so a bare "plan mode on" in prose
//     cannot match.
//   - The fragment stops at the trailing " on" and never runs to end-of-line:
//     the " (shift+tab to cycle)" and " · ← for agents" tails are layout
//     dependent and wrap/truncate at narrow widths. (A deliberate divergence
//     from claudeUsageLimitRE, whose tail IS load-bearing.)
//   - The LAST match on screen wins — the footer is the bottom-most line and
//     scrollback renders above it. Precedent: CodexAdapter.promptNotAccepted
//     scanning for the last "›" composer row (src/turns/harness/codex.ts).
//
// The U+FE0F (VS16) tolerance is measured, not hypothesized: writing the footers
// through newScreen() serializes VS16 attached to the base char with NO padding
// cell inserted between the two ⏵. The tolerant class costs nothing and survives
// a future rendering change.
//
// IMPORTANT: both constants carry /g, which makes `lastIndex` STATEFUL. They are
// consumed ONLY via text.matchAll(...) — never .exec() / .test() on the shared
// instance. (That statefulness is exactly why every other regex in ready.ts /
// codex.ts is non-global.)
const claudeModeFooterRE = /^[^\S\r\n]*(?:[⏵⏸]\uFE0F?){1,2}[^\S\r\n]*([A-Za-z][^\r\n]{0,40}?[^\S\r\n]+on)(?=[^\S\r\n]|$)/gm;
// Glyph-only presence probe: "a mode footer line IS painted", independent of
// whether the fragment parsed. Discriminates unparsed_footer from no_footer.
const claudeModeGlyphRE = /^[^\S\r\n]*(?:[⏵⏸]\uFE0F?){1,2}[^\S\r\n]/gm;
/** Footer fragment → ladder rung. Anything else is off-ladder → "unknown" + raw. */
const claudeFooterRungs = {
    "auto mode on": "auto",
    "manual mode on": "manual",
    "accept edits on": "acceptEdits",
    "plan mode on": "plan",
    "bypass permissions on": "bypass",
};
/** Returns the LAST match of a /g regex over `text`, or null. */
function lastMatch(re, text) {
    let last = null;
    for (const m of text.matchAll(re))
        last = m;
    return last;
}
function parseClaudeFooter(text) {
    const m = lastMatch(claudeModeFooterRE, text);
    if (m) {
        const raw = m[1].trim();
        const rung = claudeFooterRungs[raw.toLowerCase()];
        // A structurally-valid fragment we don't have a rung for (a rename, or the
        // epic's flag-only `dontAsk`) is preserved verbatim in `raw` — an
        // off-ladder state, NOT a failure to see.
        return rung
            ? { observed: rung, raw, source: "footer" }
            : { observed: "unknown", raw, source: "footer" };
    }
    // The fragment did not parse. If a glyph line IS painted this frame, that is
    // materially different from "no footer at all" — report the whole line.
    const g = lastMatch(claudeModeGlyphRE, text);
    if (g) {
        const line = text.slice(g.index ?? 0).split(/\r?\n/, 1)[0] ?? "";
        return { observed: "unknown", raw: line.trim(), source: "unparsed_footer" };
    }
    return { observed: "unknown", source: "no_footer" };
}
// ── codex: /status box rows ───────────────────────────────────────────────
//
//   │  Permissions:          Workspace (Ask for approval)  │
//   │  Collaboration mode:   Default                       │
//
// Both row regexes REQUIRE the closing │ on the SAME physical line, exactly as
// statusSessionRE does (src/turns/harness/codex.ts). A wrapped row therefore
// fails to match and the reading falls to "unknown" — it fails CLOSED by
// construction, at any width, so CODEX_STATUS_MIN_COLS needs no tuning for this
// read (that constant keeps its existing job: the primer's /status write gate).
//
// Non-global, matching statusSessionRE's shape — safe to .exec()/.test().
const codexPermissionsRowRE = /│[^\S\r\n]*Permissions:[^\S\r\n]+([^\r\n│]+?)[^\S\r\n]*│/;
const codexCollaborationRowRE = /│[^\S\r\n]*Collaboration mode:[^\S\r\n]+([^\r\n│]+?)[^\S\r\n]*│/;
// codexStatusHeader gates the codex parse on the startup banner. This is a
// HARNESS-IDENTITY gate, not box-presence detection: the banner is painted by
// codex itself (test/corpus/auth/codex/normal-composer/screen.txt contains
// exactly one occurrence and no Session: / Permissions: / Collaboration mode:
// row). The anti-spoof weight is carried by the │ … │ row anchors above.
const codexStatusHeader = ">_ OpenAI Codex (v";
/**
 * `Permissions:` value → ladder rung.
 *
 * `Workspace (Approve for me)` maps to NOTHING by design: the epic records it
 * has no CLI spelling (`-a granular` is rejected; the accepted `-a` values are
 * untrusted | on-request | never), so it can never be a `requested` rung.
 * Coercing it onto one would make a caller comparing `requested` to `observed`
 * raise a false drift alarm — so it reports `observed: "unknown"` with the value
 * preserved in `raw`, like any other off-ladder state.
 *
 * `Custom (workspace, never)` → `auto` is PROVISIONAL: predicted, pending
 * confirmation against a live codex 0.144.5 by a sibling task.
 */
const codexPermissionRungs = {
    "workspace (ask for approval)": "acceptEdits",
    "full access": "bypass",
    "custom (workspace, untrusted)": "manual",
    // Permissions axis only — the collaboration axis is reported separately.
    "custom (read-only, untrusted)": "plan",
    "custom (workspace, never)": "auto", // provisional
};
// The codex path always reports source "status" — the only source a pure screen
// parse can justify. The prime-outcome sources (too_narrow / not_primed /
// not_written / written_uncaptured) explain why the box never reached the
// screen, which only the CALLER (Conversation.permissionMode(), which owns the
// primer's outcome) knows; it overrides `source` accordingly when the parse
// comes back unknown.
function parseCodexStatus(text) {
    if (!text.includes(codexStatusHeader)) {
        return { observed: "unknown", collaboration: "unknown", source: "status" };
    }
    // Absence is NOT a signal: collaboration is read only from a positive row.
    const cm = codexCollaborationRowRE.exec(text);
    const collabRaw = cm?.[1].trim().toLowerCase() ?? "";
    const collaboration = collabRaw === "default"
        ? "default"
        : collabRaw === "plan"
            ? "plan"
            : "unknown";
    const pm = codexPermissionsRowRE.exec(text);
    if (!pm)
        return { observed: "unknown", collaboration, source: "status" };
    const raw = pm[1].trim();
    const rung = codexPermissionRungs[raw.toLowerCase()];
    return rung
        ? { observed: rung, raw, collaboration, source: "status" }
        : { observed: "unknown", raw, collaboration, source: "status" };
}
/**
 * parsePermissionMode extracts the permission-mode reading from a rendered
 * harness screen. `text` is a Screen.snapshot().text (one line per row).
 *
 * Returns null for a harness with no screen reader (pi / opencode / generic /
 * "") — the caller mints the "launch" reading in that case. The parser fills
 * `observed` / `raw` / `collaboration` / `source`; the CALLER
 * (Conversation.permissionMode()) fills `requested` / `requestedRaw` /
 * `generation` / `observedAt`.
 *
 * `observed` carries the PERMISSIONS axis only — it never collapses codex's
 * collaboration axis into itself.
 *
 * The switch is on the CANONICAL harness names, the same convention
 * readyForInput uses — not normHarness. That is correct by construction:
 * resolveAdapter (src/chat/conversation.ts) accepts only
 * codex | claude-code | opencode | pi | generic | "" and throws
 * ErrUnknownHarness otherwise, so opts.harness is always canonical by the time
 * a Conversation exists.
 */
export function parsePermissionMode(text, harness) {
    let screen;
    switch (harness) {
        case "claude-code":
            // The claude path caches nothing and NEVER emits "not_primed":
            // primeSessionID returns early on claude (no primeSessionIDKeys), so
            // primeOutcome is always undefined. Deriving the source from it would
            // report "we never ran the prime" when the truth is "the footer isn't
            // painted this frame, come back next frame".
            screen = parseClaudeFooter(text);
            break;
        case "codex":
            screen = parseCodexStatus(text);
            break;
        default:
            return null;
    }
    return { ...screen, generation: 0, observedAt: new Date(0) };
}
// ── normalization ─────────────────────────────────────────────────────────
/** The five rung names, mapping to themselves for every harness. */
const rungIdentity = {
    plan: "plan",
    manual: "manual",
    acceptedits: "acceptEdits",
    auto: "auto",
    bypass: "bypass",
};
/** claude's native `--permission-mode` spellings. */
const claudeNativeRungs = {
    bypasspermissions: "bypass",
    acceptedits: "acceptEdits",
    plan: "plan",
    default: "manual",
};
/**
 * codex's native `-s` (sandbox) / `-a` (approval) spellings, plus the epic's
 * sandbox+approval pairs. `-a granular` is rejected by the CLI, so
 * "Approve for me" has no entry here on purpose.
 */
const codexNativeRungs = {
    "read-only": "plan",
    untrusted: "manual",
    "on-request": "acceptEdits",
    "workspace-write": "acceptEdits",
    never: "auto",
    "danger-full-access": "bypass",
    "full-access": "bypass",
};
/**
 * normalizePermissionRung maps a ladder rung name OR a per-harness native
 * spelling to the ladder rung, or undefined when the value is off-ladder (e.g.
 * the flag-only `dontAsk`).
 *
 * A `requested === observed` drift check is only valid when BOTH sides have been
 * through this function — the launch spelling and the screen spelling are
 * different vocabularies, so comparison MUST go through it.
 */
export function normalizePermissionRung(value, harness) {
    const key = value.trim().toLowerCase();
    if (key === "")
        return undefined;
    const identity = rungIdentity[key];
    if (identity)
        return identity;
    switch (harness) {
        case "claude-code":
            return claudeNativeRungs[key];
        case "codex":
            return codexNativeRungs[key];
        default:
            return undefined;
    }
}
//# sourceMappingURL=permission.js.map