import { type Classification, type Classifier, type ClassifierInput } from "./classification.ts";
import { type Patterns } from "./detector/detector.ts";
/**
 * Report a StatusRetryLater classification when `lower` (already lowercased,
 * ANSI-stripped) contains a transport-failure fingerprint, else null.
 */
export declare function matchTransportRetry(lower: string): Classification | null;
export declare class HarnessAdapter implements Classifier {
    readonly patterns: Patterns;
    constructor(patterns: Patterns);
    classify(input: ClassifierInput): Classification;
}
//# sourceMappingURL=harnessAdapter.d.ts.map