import { type Classification, type Classifier, type ClassifierInput } from "./classification.ts";
/**
 * resolveClassifier picks the Classifier for a harness. Order:
 *  1. an explicit classifier (when supplied),
 *  2. a per-harness classifier matching the harness name,
 *  3. a generic default that detects cost/quota patterns.
 */
export declare function resolveClassifier(harness: string, classifier?: Classifier | null): Classifier;
/**
 * DefaultClassifier is the built-in fallback. It only escalates to
 * blocked_by_cost when recent output matches a known cost/quota fingerprint,
 * and only after the wrapper has decided the run looks idle.
 */
export declare class DefaultClassifier implements Classifier {
    classify(input: ClassifierInput): Classification;
}
/**
 * ClassifyOutput runs the resolved per-harness classifier as a one-shot over a
 * finished output blob. Idle is forced on so the Cost/Retry/transport patterns
 * are eligible; Quiet is left off so a trailing interactive prompt in a dead
 * process's tail is not misreported as waiting_for_input. Returns the zero
 * Classification when nothing matches.
 */
export declare function classifyOutput(harness: string, output: string): Classification;
//# sourceMappingURL=classifier.d.ts.map