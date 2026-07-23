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

/** The closed 5-rung ladder settled by META-HARNESS-99. */
export type PermissionRung =
  "plan" | "manual" | "acceptEdits" | "auto" | "bypass";

/** Why `observed` says what it says. */
export type PermissionModeSource =
  | "launch" // no reader for this harness (pi / opencode / generic / "")
  | "footer" // claude: parsed from the live footer this frame
  | "status" // codex: parsed from the /status box cached at prime
  | "no_footer" // claude: no mode-footer line painted this frame
  | "unparsed_footer" // claude: footer line IS painted, its fragment did not parse
  | "too_narrow" // codex: prime skipped, cols < CODEX_STATUS_MIN_COLS
  | "not_primed" // codex: prime never ran (resume / id already seeded)
  | "not_written" // codex: prime ran but never wrote /status
  | "written_uncaptured"; // codex: /status written, box never parsed

export interface PermissionModeReading {
  /** The rung the caller ASKED for at launch, normalized via normalizePermissionRung. */
  requested?: PermissionRung;
  /** The caller's raw launch spelling, before normalization (e.g. "bypassPermissions"). */
  requestedRaw?: string;
  /** The rung the screen reports, or "unknown". Permissions axis ONLY. */
  observed: PermissionRung | "unknown";
  /**
   * The screen fragment `observed` was derived from, when one was seen.
   *
   * A NON-EMPTY `raw` together with `observed === "unknown"` means "the session
   * is in a state OUTSIDE the ladder" (a renamed mode, `Workspace (Approve for
   * me)`, an unrecognized `Custom (…)` pair) — it does NOT mean "we couldn't
   * see". "We couldn't see" is `observed: "unknown"` with NO `raw`, and the
   * `source` says why.
   */
  raw?: string;
  /**
   * The codex collaboration axis, read ONLY from a positive `Collaboration
   * mode:` row. Absence is NOT a signal (META-HARNESS-99's explicit ruling), so
   * a missing row is "unknown", never "default".
   */
  collaboration?: "default" | "plan" | "unknown";
  source: PermissionModeSource;
  /** The screen generation the reading was taken from; filled by the caller. */
  generation: number;
  /** When the reading was taken; filled by the caller. */
  observedAt: Date;
}

/** The screen-derived subset of a reading: what a pure parse can know. */
type ScreenReading = Pick<
  PermissionModeReading,
  "observed" | "raw" | "collaboration" | "source"
>;

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
const claudeModeFooterRE =
  /^[^\S\r\n]*(?:[⏵⏸]\uFE0F?){1,2}[^\S\r\n]*([A-Za-z][^\r\n]{0,40}?[^\S\r\n]+on)(?=[^\S\r\n]|$)/gm;

// Glyph-only presence probe: "a mode footer line IS painted", independent of
// whether the fragment parsed. Discriminates unparsed_footer from no_footer.
const claudeModeGlyphRE = /^[^\S\r\n]*(?:[⏵⏸]\uFE0F?){1,2}[^\S\r\n]/gm;

/** Footer fragment → ladder rung. Anything else is off-ladder → "unknown" + raw. */
const claudeFooterRungs: Record<string, PermissionRung | undefined> = {
  "auto mode on": "auto",
  "manual mode on": "manual",
  "accept edits on": "acceptEdits",
  "plan mode on": "plan",
  "bypass permissions on": "bypass",
};

/** Returns the LAST match of a /g regex over `text`, or null. */
function lastMatch(re: RegExp, text: string): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

function parseClaudeFooter(text: string): ScreenReading {
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
// Measured widths, from the META-HARNESS-110 recordings (test/corpus/codex/
// status-*, live 0.144.5 at 120x40; "intrinsic" = the minimum unwrapped width a
// row needs, i.e. opening │ + label column + value + closing │):
//
//   Permissions:          up to 55  (widest value: Custom (workspace, untrusted))
//   Collaboration mode:      30–33
//   Session:                    62
//   Directory:                  94  (cwd-dependent, not parsed)
//
// So the load-bearing row is `Session:` at 62, ABOVE the current
// CODEX_STATUS_MIN_COLS = 60 — that constant's docstring derives 60 from the
// 36-char UUID plus "Session: " plus borders, but the real box indents the value
// into a fixed label column set by the widest label ("Collaboration mode:").
// Raising it is a documented FOLLOW-UP with this evidence, deliberately not done
// here: it is a write-gate heuristic, and both reads already fail closed.
//
// Non-global, matching statusSessionRE's shape — safe to .exec()/.test().
const codexPermissionsRowRE =
  /│[^\S\r\n]*Permissions:[^\S\r\n]+([^\r\n│]+?)[^\S\r\n]*│/;
const codexCollaborationRowRE =
  /│[^\S\r\n]*Collaboration mode:[^\S\r\n]+([^\r\n│]+?)[^\S\r\n]*│/;

// codexStatusHeader gates the codex parse on the startup banner. This is a
// HARNESS-IDENTITY gate, not box-presence detection: the banner is painted by
// codex itself (test/corpus/auth/codex/normal-composer/screen.txt contains
// exactly one occurrence and no Session: / Permissions: / Collaboration mode:
// row). The anti-spoof weight is carried by the │ … │ row anchors above.
const codexStatusHeader = ">_ OpenAI Codex (v";

/**
 * `Permissions:` value → ladder rung. FROZEN against live codex-cli 0.144.5.
 *
 * Every key below was observed end-to-end by the META-HARNESS-110 probe and is
 * carried by a recorded fixture under test/corpus/codex/status-* (each fixture's
 * meta.json names the launch flags that produced it). Nothing here is predicted.
 *
 *   launch flags                      Permissions: rendering          rung
 *   -s workspace-write -a on-request  Workspace (Ask for approval)    acceptEdits
 *   -s workspace-write -a untrusted   Custom (workspace, untrusted)   manual
 *   -s workspace-write -a never       Custom (workspace, never)       auto
 *   -s danger-full-access -a never    Full Access                     bypass
 *   -s read-only -a untrusted         Read Only (untrusted)           plan
 *   -s read-only -a never             Read Only (never)               plan
 *   -s read-only -a on-request        Read Only (Ask for approval)    plan
 *
 * Two corrections the live probe forced on the predicted table:
 *
 *   - `Custom (read-only, untrusted)` DOES NOT EXIST. 0.144.5 gives the
 *     read-only sandbox its own presentation family, `Read Only (<policy>)`,
 *     rather than the `Custom (<sandbox>, <policy>)` form. That predicted key is
 *     gone; `Read Only (untrusted)` replaces it.
 *   - The read-only family is NOT uniform in how it spells the approval policy:
 *     `untrusted` and `never` appear verbatim, `on-request` is prettified to
 *     "Ask for approval". That is why this is an exhaustive lookup of observed
 *     strings and never a parsed `<sandbox>, <policy>` pair — an unobserved
 *     spelling must fall through to unknown + raw, not be guessed at.
 *
 * All three `Read Only (…)` spellings map to `plan` on the permissions axis. The
 * approval policy is load-bearing under `workspace-write` (it discriminates
 * three rungs) but cannot be under `read-only`: nothing is writable, so there is
 * no edit for an approval policy to gate and every read-only session is the same
 * permissions posture. Mapping only the `untrusted` spelling would leave a
 * session launched `-s read-only -a never` reporting permanent unresolvable
 * drift (normalizePermissionRung maps the `read-only` launch spelling to `plan`,
 * so `requested` would be `plan` against a forever-`unknown` `observed`).
 *
 * `plan` here is the PERMISSIONS AXIS ONLY. A codex session is honestly "plan"
 * only when `observed === "plan"` AND `collaboration === "plan"` — the epic's
 * plan rung is `-s read-only -a untrusted` PLUS a post-launch `/plan`, and the
 * probe confirmed those two axes move independently (test/corpus/codex/
 * status-readonly-default and status-plan share launch flags and differ only in
 * whether `/plan` ran).
 *
 * `Workspace (Approve for me)` maps to NOTHING by design: the epic records it
 * has no CLI spelling (`-a granular` is rejected; the accepted `-a` values are
 * untrusted | on-request | never), so it can never be a `requested` rung.
 * Coercing it onto one would make a caller comparing `requested` to `observed`
 * raise a false drift alarm — so it reports `observed: "unknown"` with the value
 * preserved in `raw`, like any other off-ladder state. It was NOT re-probed by
 * META-HARNESS-110 (unreachable from the CLI); the exclusion stands on that same
 * reasoning.
 */
const codexPermissionRungs: Record<string, PermissionRung | undefined> = {
  "workspace (ask for approval)": "acceptEdits",
  "full access": "bypass",
  "custom (workspace, untrusted)": "manual",
  "custom (workspace, never)": "auto",
  // Permissions axis only — the collaboration axis is reported separately.
  "read only (untrusted)": "plan",
  "read only (never)": "plan",
  "read only (ask for approval)": "plan",
};

// The codex path always reports source "status" — the only source a pure screen
// parse can justify. The prime-outcome sources (too_narrow / not_primed /
// not_written / written_uncaptured) explain why the box never reached the
// screen, which only the CALLER (Conversation.permissionMode(), which owns the
// primer's outcome) knows; it overrides `source` accordingly when the parse
// comes back unknown.
function parseCodexStatus(text: string): ScreenReading {
  if (!text.includes(codexStatusHeader)) {
    return { observed: "unknown", collaboration: "unknown", source: "status" };
  }

  // Absence is NOT a signal: collaboration is read only from a positive row.
  const cm = codexCollaborationRowRE.exec(text);
  const collabRaw = cm?.[1].trim().toLowerCase() ?? "";
  const collaboration: "default" | "plan" | "unknown" =
    collabRaw === "default"
      ? "default"
      : collabRaw === "plan"
        ? "plan"
        : "unknown";

  const pm = codexPermissionsRowRE.exec(text);
  if (!pm) return { observed: "unknown", collaboration, source: "status" };
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
export function parsePermissionMode(
  text: string,
  harness: string,
): PermissionModeReading | null {
  let screen: ScreenReading;
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
const rungIdentity: Record<string, PermissionRung | undefined> = {
  plan: "plan",
  manual: "manual",
  acceptedits: "acceptEdits",
  auto: "auto",
  bypass: "bypass",
};

/** claude's native `--permission-mode` spellings. */
const claudeNativeRungs: Record<string, PermissionRung | undefined> = {
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
const codexNativeRungs: Record<string, PermissionRung | undefined> = {
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
export function normalizePermissionRung(
  value: string,
  harness: string,
): PermissionRung | undefined {
  const key = value.trim().toLowerCase();
  if (key === "") return undefined;
  const identity = rungIdentity[key];
  if (identity) return identity;
  switch (harness) {
    case "claude-code":
      return claudeNativeRungs[key];
    case "codex":
      return codexNativeRungs[key];
    default:
      return undefined;
  }
}
