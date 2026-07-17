import { GenericAdapter } from "../generic.ts";
import type { Adapter } from "../types.ts";
/** Adapter implements turns.Adapter for the OpenCode CLI. */
export declare class OpenCodeAdapter extends GenericAdapter implements Adapter {
    name(): string;
    /**
     * Implements turns.StreamInterleaved. OpenCode shows no interleaved
     * stream-json surface in-repo, so it is not Stream-eligible in A1 and does not
     * implement StreamParser.parseStreamLine. The Stream branch is scaffolding lit
     * up by a later interleaving adapter.
     */
    streamInterleaved(): boolean;
}
/** Constructs an OpenCode adapter. */
export declare function New(): OpenCodeAdapter;
//# sourceMappingURL=opencode.d.ts.map