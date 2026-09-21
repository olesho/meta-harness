import { type Classification } from "./classification.ts";
/**
 * The `rule` stamped on an ErrTransient result that classifyFinishedOutput
 * refined to ErrTimeout. The "wrapper/" prefix is not a package name: it is the
 * id loom already records for this rewrite in its evidence log, so it must not
 * change.
 */
export declare const RuleTimeoutUpgrade = "wrapper/timeout_upgrade";
/**
 * classifyFinishedOutput classifies the output of a harness that has already
 * exited. Order:
 *  1. the resolved classifier, exactly as classifyOutput runs it;
 *  2. an actionable result is returned unchanged — including binary_not_found,
 *     which is a statement about the launch, not the output;
 *  3. only on ErrNone / ErrUnknown are the residual rows consulted, and a hit
 *     REPLACES the result;
 *  4. an ErrTransient result whose surrounding text names a timeout becomes
 *     ErrTimeout (its own backoff bucket downstream);
 *  5. a rate-limited result with no wait hint gets one from a Retry-After token
 *     anywhere in the output.
 * Returns the classifier's own result when nothing matches, so a caller's
 * exit-code fallback still applies.
 */
export declare function classifyFinishedOutput(harness: string, output: string): Classification;
//# sourceMappingURL=finished.d.ts.map