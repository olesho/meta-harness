/**
 * ErrorClass is an additive public API consumed by multiple repos: new values
 * may be appended, but existing values and their string forms are stable.
 *
 * Represented as a number (the TS analogue of Go's iota enum) so values compare
 * by identity and serialize stably.
 */
export type ErrorClass = number;
export declare const ErrNone: ErrorClass;
export declare const ErrRateLimited: ErrorClass;
export declare const ErrAuth: ErrorClass;
export declare const ErrBilling: ErrorClass;
export declare const ErrModelNotFound: ErrorClass;
export declare const ErrContextOverflow: ErrorClass;
export declare const ErrTimeout: ErrorClass;
export declare const ErrTransient: ErrorClass;
export declare const ErrUnknown: ErrorClass;
/**
 * Return the canonical wire/display name. These strings are a stable contract
 * consumed by downstream serializers, so they match the long-standing names
 * (ErrAuth → "AuthFailure", not "ErrAuth").
 */
export declare function errorClassString(c: ErrorClass): string;
/** Map an upstream API status code to an ErrorClass. */
export declare function classFromHTTPCode(code: number): ErrorClass;
/**
 * Disambiguate a cost/quota pattern hit: billing-flavored phrases are
 * ErrBilling (fatal); everything else is ErrRateLimited (transient).
 */
export declare function costClass(hit: string): ErrorClass;
/** Refine a transient retry hit into ErrTimeout when the text names a timeout. */
export declare function retryClass(hit: string): ErrorClass;
//# sourceMappingURL=errorclass.d.ts.map