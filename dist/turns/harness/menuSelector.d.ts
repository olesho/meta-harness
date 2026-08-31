import type { InputOption } from "../types.ts";
export declare const selectorGlyph = "\u276F";
export declare const minSelectorRows = 2;
export declare const maxSelectorRows = 8;
/**
 * parseSelectorMenu extracts the choices of an unnumbered, selector-highlighted
 * menu from `after` — the frame text FOLLOWING the dialog anchor. It returns an
 * empty array when the shape is anything other than a confidently identified
 * block of sibling choice rows; callers treat that as "unparseable", never as
 * "no dialog".
 *
 * The rules, in order (each one exists to reject a specific real line of the
 * captured frame):
 *
 *  1. Take the FIRST line carrying "❯" after the anchor. Its label column — the
 *     code-point index of the first non-space rune after the glyph and its
 *     padding — is the block's alignment key.
 *  2. Expand contiguously up and down from that row. A sibling qualifies only if
 *     it is non-blank, starts its text at exactly the same label column, carries
 *     no "❯" of its own, and is not a terminator (blank, box border, footer
 *     hint). The column rule is what excludes "Security guide", the workspace
 *     path and the prose line: choice labels start ~3 columns in, surrounding
 *     prose starts at the box column.
 *  3. The block must hold between minSelectorRows and maxSelectorRows rows.
 */
export declare function parseSelectorMenu(after: string): InputOption[];
/**
 * hasChoiceShapedLine reports whether `after` (the frame text following a dialog
 * anchor) contains anything that LOOKS like a menu row — a selector-highlighted
 * line or a numbered one. It is the discriminator between DetectPending (the
 * menu has not painted yet: a mid-render frame, and silence is correct) and
 * DetectUnparseable (the menu IS there and we could not read it, which must be
 * loud).
 */
export declare function hasChoiceShapedLine(after: string): boolean;
/**
 * candidateLines returns up to maxSelectorRows non-blank lines following the
 * anchor, trimmed. They are the evidence in an unrecognized-dialog report — and,
 * hashed with the anchor, its dedup fingerprint — so an operator reading the log
 * sees the shape that defeated the parser rather than just its name.
 */
export declare function candidateLines(after: string): string[];
/** cleanLabel truncates a menu label at its first double-space run (padding or
 * a box border) and trims the remainder. */
export declare function cleanLabel(s: string): string;
/** aliasForLabel maps a choice label onto the stable policy alias
 * ("proceed"/"deny"), or "" when it is neither. */
export declare function aliasForLabel(label: string): string;
//# sourceMappingURL=menuSelector.d.ts.map