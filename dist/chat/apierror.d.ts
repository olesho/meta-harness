import { type TurnCode } from "./types.ts";
/** What a transcript tag decided about a turn. */
export interface ApiErrorVerdict {
    /**
     * The canonical `Turn.reason` for a WALL; empty for every other mapped tag,
     * which get a generic errored reason naming the tag instead.
     */
    reason: string;
    /**
     * The wall token; absent for every non-wall verdict. Absent means "not a
     * wall", never "unclassified".
     */
    code?: TurnCode;
    /** The harness's own tag, carried into the reason as evidence. */
    tag: string;
    /** The rendered error the harness printed. */
    text: string;
}
/** A transcript turn as far as this module needs it. */
export interface TaggedTurn {
    role: string;
    text: string;
    apiError?: string;
}
/**
 * apiErrorVerdictFrom applies the LAST WORD ONLY rule: scan backwards from the
 * end for the most recent assistant entry at or beyond the watermark, and let
 * only THAT entry decide. A tagged entry followed by a real reply means the
 * harness retried and succeeded. `null` watermark ("could not establish how far
 * the transcript already extended") is a decline, never a zero.
 */
export declare function apiErrorVerdictFrom(turns: readonly TaggedTurn[], watermark: number | null): ApiErrorVerdict | null;
/** Bounds how much of the harness's rendered error rides in the reason. */
export declare const apiErrorDetailCap = 240;
/**
 * turnReason renders the `Turn.reason` for a verdict: the canonical wall reason
 * where there is one, otherwise a generic errored reason naming the harness.
 * Either way the harness's own tag and its rendered text ride along as the
 * evidence, so an operator reads WHY, in the harness's own words.
 */
export declare function turnReason(v: ApiErrorVerdict, harness: string): string;
/**
 * oneLineCapped flattens text to a single line and truncates it on a character
 * boundary so a reason stays safe in a log line or a JSON state file.
 *
 * The cap is in UTF-8 BYTES, as in harness-wrapper (Go's len() counts bytes),
 * and the cut backs up to a code-point boundary; counting UTF-16 units instead
 * would render a different reason than the Go side for the same non-ASCII text.
 */
export declare function oneLineCapped(s: string, max: number): string;
//# sourceMappingURL=apierror.d.ts.map