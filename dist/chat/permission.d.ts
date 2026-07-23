/** The closed 5-rung ladder settled by META-HARNESS-99. */
export type PermissionRung = "plan" | "manual" | "acceptEdits" | "auto" | "bypass";
/** Why `observed` says what it says. */
export type PermissionModeSource = "launch" | "footer" | "status" | "no_footer" | "unparsed_footer" | "too_narrow" | "not_primed" | "not_written" | "written_uncaptured";
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
/**
 * codex's collaboration axis, minus the un-requestable "unknown".
 *
 * Derived from `PermissionModeReading["collaboration"]` rather than spelled out
 * again, so the requestable set cannot drift from the readable one: "unknown"
 * is a READING outcome (no positive `Collaboration mode:` row was seen), never
 * something a caller can ask setPermissionMode to reach.
 */
export type CollaborationMode = Exclude<NonNullable<PermissionModeReading["collaboration"]>, "unknown">;
/**
 * What setPermissionMode accepts: a ladder rung (META-HARNESS-99's closed 5-rung
 * ladder) or a codex collaboration mode.
 *
 * The union is deliberately WIDER than any single harness: which half is legal
 * depends on the harness the session runs. Asking for a target off this
 * harness's axis (a ladder rung on codex, `"default"` on claude) is a runtime
 * ErrPermissionModeUnreachable, not a compile error — the harness is not in the
 * type.
 */
export type PermissionModeTarget = PermissionRung | CollaborationMode;
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
export declare function parsePermissionMode(text: string, harness: string): PermissionModeReading | null;
/**
 * normalizePermissionRung maps a ladder rung name OR a per-harness native
 * spelling to the ladder rung, or undefined when the value is off-ladder (e.g.
 * the flag-only `dontAsk`).
 *
 * A `requested === observed` drift check is only valid when BOTH sides have been
 * through this function — the launch spelling and the screen spelling are
 * different vocabularies, so comparison MUST go through it.
 */
export declare function normalizePermissionRung(value: string, harness: string): PermissionRung | undefined;
//# sourceMappingURL=permission.d.ts.map