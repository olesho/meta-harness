// The canonical, lifecycle-free taxonomy of harness-output errors. It is the
// mechanism half of the classification contract: the wrapper assigns it from
// harness output; downstream consumers map it to their own policy.
export const ErrNone = 0; // not an error (clean exit, waiting, idle)
export const ErrRateLimited = 1; // 429 / usage|session limit — transient
export const ErrAuth = 2; // 401 / invalid key — fatal
export const ErrBilling = 3; // 402 / payment / insufficient credits — fatal
export const ErrModelNotFound = 4; // 404 / model does not exist
export const ErrContextOverflow = 5; // context/token limit (reserved)
export const ErrTimeout = 6; // request/connection timeout
export const ErrTransient = 7; // 5xx / transport reset / temporary
export const ErrUnknown = 8; // unclassifiable failure
/**
 * Return the canonical wire/display name. These strings are a stable contract
 * consumed by downstream serializers, so they match the long-standing names
 * (ErrAuth → "AuthFailure", not "ErrAuth").
 */
export function errorClassString(c) {
    switch (c) {
        case ErrNone:
            return "None";
        case ErrRateLimited:
            return "RateLimited";
        case ErrAuth:
            return "AuthFailure";
        case ErrBilling:
            return "BillingError";
        case ErrModelNotFound:
            return "ModelNotFound";
        case ErrContextOverflow:
            return "ContextOverflow";
        case ErrTimeout:
            return "Timeout";
        case ErrTransient:
            return "Transient";
        default:
            return "Unknown";
    }
}
/** Map an upstream API status code to an ErrorClass. */
export function classFromHTTPCode(code) {
    if (code === 401)
        return ErrAuth;
    if (code === 402)
        return ErrBilling;
    if (code === 404)
        return ErrModelNotFound;
    if (code === 429)
        return ErrRateLimited;
    if (code === 408 || (code >= 500 && code <= 599))
        return ErrTransient;
    if (code === 0)
        return ErrTransient;
    return ErrUnknown;
}
// billingHints distinguish a billing/quota failure (fatal) from a usage/rate
// limit (transient) among cost-pattern hits.
const billingHints = ["payment", "insufficient", "credit", "billing", "quota exceeded"];
/**
 * Disambiguate a cost/quota pattern hit: billing-flavored phrases are
 * ErrBilling (fatal); everything else is ErrRateLimited (transient).
 */
export function costClass(hit) {
    const h = hit.toLowerCase();
    for (const b of billingHints) {
        if (h.includes(b))
            return ErrBilling;
    }
    return ErrRateLimited;
}
// timeoutHints mark a retryable failure as specifically a timeout.
const timeoutHints = ["timeout", "timed out", "deadline exceeded", "etimedout"];
/** Refine a transient retry hit into ErrTimeout when the text names a timeout. */
export function retryClass(hit) {
    const h = hit.toLowerCase();
    for (const t of timeoutHints) {
        if (h.includes(t))
            return ErrTimeout;
    }
    return ErrTransient;
}
//# sourceMappingURL=errorclass.js.map