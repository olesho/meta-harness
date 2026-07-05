// The classifier resolution + the public one-shot ClassifyOutput entry point.
import { isCostOrQuotaLimited, stripANSIEscapes } from "./ansi.js";
import { noClassification, } from "./classification.js";
import { costClass } from "./errorclass.js";
import { HarnessAdapter, matchTransportRetry } from "./harnessAdapter.js";
import { Patterns as claudePatterns } from "./harness/claude.js";
import { Patterns as codexPatterns } from "./harness/codex.js";
import { Patterns as cursorPatterns } from "./harness/cursor.js";
import { Patterns as opencodePatterns } from "./harness/opencode.js";
import { Patterns as piPatterns } from "./harness/pi.js";
import { StatusBlockedByCost } from "./status.js";
/**
 * resolveClassifier picks the Classifier for a harness. Order:
 *  1. an explicit classifier (when supplied),
 *  2. a per-harness classifier matching the harness name,
 *  3. a generic default that detects cost/quota patterns.
 */
export function resolveClassifier(harness, classifier) {
    if (classifier)
        return classifier;
    switch (harness.trim().toLowerCase()) {
        case "claude":
        case "claude-code":
            return new HarnessAdapter(claudePatterns);
        case "codex":
            return new HarnessAdapter(codexPatterns);
        case "cursor":
            return new HarnessAdapter(cursorPatterns);
        case "opencode":
            return new HarnessAdapter(opencodePatterns);
        case "pi":
            return new HarnessAdapter(piPatterns);
    }
    return new DefaultClassifier();
}
/**
 * DefaultClassifier is the built-in fallback. It only escalates to
 * blocked_by_cost when recent output matches a known cost/quota fingerprint,
 * and only after the wrapper has decided the run looks idle.
 */
export class DefaultClassifier {
    classify(input) {
        if (!input.idle)
            return noClassification();
        const phrase = isCostOrQuotaLimited(input.recentOutput);
        if (phrase !== "") {
            return {
                ...noClassification(),
                status: StatusBlockedByCost,
                class: costClass(phrase),
                reason: phrase,
                terminal: true,
            };
        }
        const transport = matchTransportRetry(stripANSIEscapes(input.recentOutput).toLowerCase());
        if (transport)
            return transport;
        return noClassification();
    }
}
/**
 * ClassifyOutput runs the resolved per-harness classifier as a one-shot over a
 * finished output blob. Idle is forced on so the Cost/Retry/transport patterns
 * are eligible; Quiet is left off so a trailing interactive prompt in a dead
 * process's tail is not misreported as waiting_for_input. Returns the zero
 * Classification when nothing matches.
 */
export function classifyOutput(harness, output) {
    return resolveClassifier(harness).classify({
        recentOutput: output,
        idle: true,
        quiet: false,
    });
}
//# sourceMappingURL=classifier.js.map