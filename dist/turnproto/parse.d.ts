import type { StructuredTurnResult } from "./protocol.ts";
/**
 * parseLastJSONLine returns the LAST line of `stdout` that parses as a JSON
 * object, or null when no line does. Bare JSON scalars/arrays are rejected — the
 * protocol payload is always an object.
 */
export declare function parseLastJSONLine(stdout: string): StructuredTurnResult | null;
//# sourceMappingURL=parse.d.ts.map