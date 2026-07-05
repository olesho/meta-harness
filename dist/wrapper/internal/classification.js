// Classifier input/output types and the Classifier interface.
import { ErrNone } from "./errorclass.js";
/** The zero Classification ("no classification"). */
export function noClassification() {
    return {
        status: "",
        class: ErrNone,
        reason: "",
        terminal: false,
        httpCode: 0,
        retryAfter: 0,
        resumeAt: null,
    };
}
//# sourceMappingURL=classification.js.map