import { type ErrorClass } from "./errorclass.ts";
import { type Status } from "./status.ts";
/**
 * ClassifierInput is the snapshot a Classifier inspects. It is rebuilt each
 * time the wrapper polls the classifier; classifiers are stateless.
 */
export interface ClassifierInput {
    /** Tail of the harness PTY output (last ~64KB), ANSI escapes intact. */
    recentOutput: string;
    /** Duration in ms since the harness last produced a byte. */
    sinceLastOutput?: number;
    /** True once sinceLastOutput >= IdleQuiet. */
    quiet?: boolean;
    /** True once sinceLastOutput >= IdleClassify. */
    idle?: boolean;
}
/** A Classifier's verdict for a single ClassifierInput. */
export interface Classification {
    /** The actionable status matched. Empty string means "no classification". */
    status: Status;
    /** The canonical harness-output error taxonomy for this classification. */
    class: ErrorClass;
    /** Short human-readable description. */
    reason: string;
    /** Whether the wrapper should terminate the harness to make progress. */
    terminal: boolean;
    /** Upstream HTTP status code when status is StatusAPIError, else 0. */
    httpCode: number;
    /** Suggested wait in milliseconds, or 0 when none was parseable. */
    retryAfter: number;
    /** Absolute reset instant from a session-limit banner, or null. */
    resumeAt: Date | null;
}
/** Inspects recent harness output and reports actionable classifications. */
export interface Classifier {
    classify(input: ClassifierInput): Classification;
}
/** The zero Classification ("no classification"). */
export declare function noClassification(): Classification;
//# sourceMappingURL=classification.d.ts.map