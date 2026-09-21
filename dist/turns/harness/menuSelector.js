// The UNNUMBERED (selector-only) menu shape claude renders, plus the label
// helpers both menu shapes share.
//
// Port of pkg/turns/harness/claudecode/menu_selector.go.
//
// Claude Code 2.1.251 renders the folder-trust dialog WITHOUT choice numbers
// (captured live, tmux, 2026-08-29 — see PUPPET-236):
//
//   Accessing workspace:
//   /private/tmp/trustrepo
//   Quick safety check: Is this a project you created or one you trust? …
//   Claude Code'll be able to read, edit, and execute files here.
//   Security guide
//    ❯ No, exit
//      Yes, I trust this folder
//   Enter to confirm · Esc to cancel
//
// `menuRE` (claudecode.ts) requires "<digit>.", so it yields nothing here and
// the dialog used to read as "no dialog at all" — see DetectInputDetail. Two
// details make a careless parser dangerous rather than merely useless:
//
//   - The default highlight sits on "No, exit". Answering with a bare CR, or
//     assuming the affirmative row comes first, QUITS claude at startup.
//   - The surrounding frame is prose ("Security guide", the workspace path, the
//     "Enter to confirm · Esc to cancel" footer). A parser that took "every line
//     after the anchor" would mint spurious options and shift the arrow offsets
//     of the real rows below them.
//
// All column arithmetic here indexes CODE POINTS (see `runes`), never UTF-16 units,
// mirroring Go's `[]rune`. The captured frame is all-BMP so `.length` happens to
// agree today, but a folder name carrying an emoji would silently shift every
// column and drop the row.
const enc = new TextEncoder();
// selectorGlyph is the highlight marker Claude Code paints on the currently
// selected row (U+276F). It is ALSO the composer prompt glyph, which is why
// selector scanning only ever runs on the text that FOLLOWS a dialog anchor.
export const selectorGlyph = "❯";
// minSelectorRows / maxSelectorRows bound a selector block. A single row is not
// a choice (that is what a stray composer glyph looks like), and a block longer
// than the cap is more likely to be prose that happens to align than a menu —
// both are reported unparseable, which is loud, rather than mis-navigated.
export const minSelectorRows = 2;
export const maxSelectorRows = 8;
// borderRunes are the box-drawing glyphs Claude Code frames a dialog with. They
// appear as a line's left edge (stripped by lineContent so a boxed dialog
// measures its label column like a bare one) and as whole separator lines
// (terminators, see isTerminator).
const borderRunes = "╭╮╰╯─━│┃┌┐└┘├┤┼═║";
// footerHintRE matches the hint line a dialog closes with ("Enter to confirm ·
// Esc to cancel"). It is a terminator: it can align with the choice rows in some
// renderings, and it is not a choice.
const footerHintRE = /(enter to confirm|enter to continue|esc to |·)/i;
// numberedLineRE recognizes a choice-SHAPED numbered line for the pending vs
// unparseable discrimination in DetectInputDetail. It is deliberately looser
// than menuRE (no label requirement): the question it answers is "did the menu
// render at all", not "can we parse it".
const numberedLineRE = /^[^\dA-Za-z\n]*\d\./m;
// runes splits a string into CODE POINTS, the direct analogue of Go's []rune —
// what every column computation in this file indexes. `for…of` over a string
// iterates code points, so this pairs a surrogate pair into one element where
// `.split("")` or a raw index would tear it in half.
//
// Written as a loop rather than `Array.from(s)` only to satisfy
// @typescript-eslint/no-misused-spread, whose objection (a code point is not a
// grapheme cluster) does not apply here: the reference implementation indexes
// code points, and matching it exactly is the requirement.
function runes(s) {
    const out = [];
    for (const ch of s)
        out.push(ch);
    return out;
}
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
export function parseSelectorMenu(after) {
    const lines = after.split("\n");
    let highlight = -1;
    let labelCol = -1;
    for (let i = 0; i < lines.length; i++) {
        const col = selectorLabelColumn(lineContent(lines[i]));
        if (col < 0)
            continue;
        highlight = i;
        labelCol = col;
        break;
    }
    if (highlight < 0)
        return [];
    let start = highlight;
    let end = highlight;
    for (let i = highlight - 1; i >= 0; i--) {
        if (!isSelectorSibling(lines[i], labelCol))
            break;
        start = i;
    }
    for (let i = highlight + 1; i < lines.length; i++) {
        if (!isSelectorSibling(lines[i], labelCol))
            break;
        end = i;
    }
    const rows = end - start + 1;
    if (rows < minSelectorRows || rows > maxSelectorRows)
        return [];
    const opts = [];
    for (let i = start; i <= end; i++) {
        const r = runes(lineContent(lines[i]));
        if (labelCol >= r.length)
            return [];
        const label = cleanLabel(r.slice(labelCol).join(""));
        if (label === "")
            return [];
        opts.push({
            // id is the 0-based row index. A distinct namespace from the numbered
            // form's 1-based digits, which is fine: ids need only be unique WITHIN a
            // request and nothing persists them. findOption (src/chat/conversation.ts)
            // matches id, alias AND label, so alias-based policy ("proceed"/"deny")
            // keeps working across both shapes.
            id: String(i - start),
            alias: aliasForLabel(label),
            label,
            keys: selectorKeys(i - highlight),
            // Server-side only; excluded from the request id hash (inputID hashes
            // kind + prompt + labels), so an arrow keypress that moves the highlight
            // does NOT mint a "new" request the policy answers a second time.
            highlighted: i === highlight,
        });
    }
    return opts;
}
/**
 * selectorKeys encodes "move from the highlighted row to the row `delta` below
 * it, then confirm". There are no digits to press, so selection is RELATIVE.
 *
 * Three properties this function must keep:
 *
 *   - NEVER a bare CR for a non-highlighted row. Claude highlights "No, exit" by
 *     default, so a bare CR answers "yes" by quitting — the entire bug class this
 *     parser exists for.
 *   - The result is written as a SINGLE PTY write (Conversation.writeKeys passes
 *     the whole opt.keys to one writeStdin). "ESC [ B" arriving in one write
 *     parses as Down; split across writes it is a lone Esc, which CANCELS the
 *     dialog. Do not split it, and do not sleep between the arrows. In
 *     particular this must NOT reuse send()'s deliberate text/submit split
 *     (the META-HARNESS-24 paste-detection workaround) — that reasoning is about
 *     composer text, and applying it here would break the dialog.
 *   - Arrow repetition, not absolute addressing: the offsets are only valid
 *     against the highlight they were derived from, which is why the highlight
 *     row is captured in the same pass as the labels.
 */
function selectorKeys(delta) {
    if (delta > 0)
        return enc.encode("\x1b[B".repeat(delta) + "\r");
    if (delta < 0)
        return enc.encode("\x1b[A".repeat(-delta) + "\r");
    return enc.encode("\r");
}
// isSelectorSibling reports whether line is another choice row of a block whose
// labels start at labelCol: non-blank, no selector glyph of its own, not a
// terminator, and aligned to exactly that column.
function isSelectorSibling(line, labelCol) {
    if (isTerminator(line))
        return false;
    const content = lineContent(line);
    if (content.includes(selectorGlyph))
        return false;
    return textColumn(content) === labelCol;
}
// isTerminator reports whether line ends a selector block: a blank line, a whole
// line of box-drawing chrome, or the dialog's footer hint.
function isTerminator(line) {
    const trimmed = line.trim();
    if (trimmed === "")
        return true;
    if (footerHintRE.test(trimmed))
        return true;
    for (const ch of trimmed) {
        if (ch !== " " && !borderRunes.includes(ch))
            return false;
    }
    return true;
}
// lineContent strips a leading box border — the frame's left edge and the
// padding before it — so "│ ❯ No, exit" and " ❯ No, exit" measure the same label
// column. Only ONE leading border glyph is removed; everything after it,
// including the padding that sets the column, is preserved verbatim.
function lineContent(line) {
    const r = runes(line);
    let i = 0;
    while (i < r.length && (r[i] === " " || r[i] === "\t"))
        i++;
    if (i < r.length && borderRunes.includes(r[i]))
        return r.slice(i + 1).join("");
    return line;
}
// selectorLabelColumn returns the code-point index at which the label of a
// "❯"-highlighted row begins — past the glyph and its trailing padding — or -1
// when content carries no glyph or nothing follows it.
function selectorLabelColumn(content) {
    const r = runes(content);
    for (let i = 0; i < r.length; i++) {
        if (r[i] !== selectorGlyph)
            continue;
        let j = i + 1;
        while (j < r.length && (r[j] === " " || r[j] === "\t"))
            j++;
        if (j >= r.length)
            return -1;
        return j;
    }
    return -1;
}
// textColumn returns the code-point index of the first non-space rune, or -1 for
// a blank line.
function textColumn(content) {
    const r = runes(content);
    for (let i = 0; i < r.length; i++) {
        if (r[i] !== " " && r[i] !== "\t")
            return i;
    }
    return -1;
}
/**
 * hasChoiceShapedLine reports whether `after` (the frame text following a dialog
 * anchor) contains anything that LOOKS like a menu row — a selector-highlighted
 * line or a numbered one. It is the discriminator between DetectPending (the
 * menu has not painted yet: a mid-render frame, and silence is correct) and
 * DetectUnparseable (the menu IS there and we could not read it, which must be
 * loud).
 */
export function hasChoiceShapedLine(after) {
    return after.includes(selectorGlyph) || numberedLineRE.test(after);
}
/**
 * candidateLines returns up to maxSelectorRows non-blank lines following the
 * anchor, trimmed. They are the evidence in an unrecognized-dialog report — and,
 * hashed with the anchor, its dedup fingerprint — so an operator reading the log
 * sees the shape that defeated the parser rather than just its name.
 */
export function candidateLines(after) {
    const out = [];
    for (const ln of after.split("\n")) {
        const t = ln.trim();
        if (t === "")
            continue;
        out.push(t);
        if (out.length === maxSelectorRows)
            break;
    }
    return out;
}
// --- label helpers, shared by both menu shapes -----------------------------
//
// These live here rather than in claudecode.ts only to keep the import edge
// one-way: the selector parser needs them, and claudecode.ts already imports
// this module. Keeping them there instead would make the two files circular,
// and exporting them from claudecode.ts would widen the frozen public surface
// (test/testdata/ts_surface.golden) with two internal helpers.
/** cleanLabel truncates a menu label at its first double-space run (padding or
 * a box border) and trims the remainder. */
export function cleanLabel(s) {
    const i = s.indexOf("  ");
    if (i >= 0)
        s = s.slice(0, i);
    return s.trim();
}
/** aliasForLabel maps a choice label onto the stable policy alias
 * ("proceed"/"deny"), or "" when it is neither. */
export function aliasForLabel(label) {
    const l = label.toLowerCase();
    if (containsAny(l, "proceed", "accept", "trust", "yes", "continue")) {
        return "proceed";
    }
    if (containsAny(l, "exit", "deny", "reject", "cancel", "no,", "no ", "don't", "do not")) {
        return "deny";
    }
    return "";
}
function containsAny(s, ...subs) {
    return subs.some((sub) => s.includes(sub));
}
//# sourceMappingURL=menuSelector.js.map