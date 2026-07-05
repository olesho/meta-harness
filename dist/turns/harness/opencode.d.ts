import { GenericAdapter } from "../generic.ts";
import type { Adapter } from "../types.ts";
/** Adapter implements turns.Adapter for the OpenCode CLI. */
export declare class OpenCodeAdapter extends GenericAdapter implements Adapter {
    name(): string;
}
/** Constructs an OpenCode adapter. */
export declare function New(): OpenCodeAdapter;
//# sourceMappingURL=opencode.d.ts.map