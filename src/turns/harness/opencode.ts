// Turn-detection adapter for the OpenCode CLI (github.com/sst/opencode).
//
// v0.1, ahead of corpus recording: no end-of-turn marker, session-id scrape, or
// transcript reader identified yet (the on-disk store is in flux), so it simply
// delegates to the generic adapter. Port of pkg/turns/harness/opencode.

import { GenericAdapter } from "../generic.ts";
import type { Adapter } from "../types.ts";

/** Adapter implements turns.Adapter for the OpenCode CLI. */
export class OpenCodeAdapter extends GenericAdapter implements Adapter {
  override name(): string {
    return "opencode";
  }

  /**
   * Implements turns.StreamInterleaved. OpenCode shows no interleaved
   * stream-json surface in-repo, so it is not Stream-eligible in A1 and does not
   * implement StreamParser.parseStreamLine. The Stream branch is scaffolding lit
   * up by a later interleaving adapter.
   */
  streamInterleaved(): boolean {
    return false;
  }
}

/** Constructs an OpenCode adapter. */
export function New(): OpenCodeAdapter {
  return new OpenCodeAdapter();
}
