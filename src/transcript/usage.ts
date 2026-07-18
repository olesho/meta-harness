// Token-usage extraction from on-disk harness sessions. The canonical Event DTO
// deliberately carries no token fields (it is a byte-identical port of the
// harness-wrapper public transcript contract), so consumers that need usage —
// cost/usage reporting in an orchestrator — read it separately from the same
// session file the transcript Readers parse. Values mirror each harness's OWN
// reporting; nothing is estimated:
//   - claude-code: per-API-call `message.usage` on assistant lines, summed once
//     per call (multiple content blocks from one call repeat the same usage —
//     deduped by message id). input_tokens EXCLUDES cache reads/creates (they
//     are the separate cache_* fields), matching Anthropic API semantics.
//   - codex: the LAST `token_count` event's cumulative `info.total_token_usage`.
//     input_tokens INCLUDES cached_input_tokens, matching codex's own semantics
//     (cacheReadInputTokens is the cached subset, not an addition).
// Neither on-disk format reports cost, so Usage has no cost field — consumers
// must not fabricate one from a price table.

import { parseFromBytes } from "./parse.ts";
import { TypeAssistant } from "./line.ts";
import { parseRollout } from "./codex/parseCodex.ts";

// Usage is the per-session token accounting read back from a harness's on-disk
// session. All fields are totals for the whole session file.
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  // Prompt tokens served from cache (claude cache_read_input_tokens; codex
  // cached_input_tokens — for codex this is a SUBSET of inputTokens).
  cacheReadInputTokens: number;
  // Prompt tokens written to cache (claude cache_creation_input_tokens; codex
  // has no cache-write accounting, always 0 there).
  cacheCreationInputTokens: number;
  // Reasoning tokens (codex reasoning_output_tokens, a subset of outputTokens
  // per codex's reporting; claude does not report them, always 0 there).
  reasoningOutputTokens: number;
}

// usageToPublicJSON maps Usage onto the snake_case wire shape, mirroring the
// harnesses' own field naming (Anthropic-style cache_* keys).
export function usageToPublicJSON(u: Usage): Record<string, number> {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cacheReadInputTokens,
    cache_creation_input_tokens: u.cacheCreationInputTokens,
    reasoning_output_tokens: u.reasoningOutputTokens,
  };
}

function toCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

interface ClaudeUsageBlock {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

// usageFromClaudeJSONL sums per-API-call usage across a Claude Code session
// transcript. Claude writes one JSONL line per content block, so several lines
// can share one API call's message id AND repeat its usage — each call is
// counted once (dedup key: message.id, falling back to the line uuid). Returns
// null when no line carries usage (e.g. a transcript from a version that did
// not record it).
export function usageFromClaudeJSONL(data: string): Usage | null {
  const seen = new Set<string>();
  let found = false;
  const total: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  for (const line of parseFromBytes(data)) {
    if (line.type !== TypeAssistant) continue;
    const msg = line.message as
      { id?: unknown; usage?: ClaudeUsageBlock } | undefined;
    const usage = msg?.usage;
    if (!usage || typeof usage !== "object") continue;
    const key =
      typeof msg?.id === "string" && msg.id !== ""
        ? msg.id
        : "line:" + line.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    found = true;
    total.inputTokens += toCount(usage.input_tokens);
    total.outputTokens += toCount(usage.output_tokens);
    total.cacheReadInputTokens += toCount(usage.cache_read_input_tokens);
    total.cacheCreationInputTokens += toCount(
      usage.cache_creation_input_tokens,
    );
  }
  return found ? total : null;
}

interface CodexTokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

// usageFromCodexJSONL reads the session totals from a Codex rollout: the last
// `token_count` event's `info.total_token_usage` is cumulative, so only that
// one counts. Returns null when the rollout has no token_count with usage info
// (info can legitimately be null on early events).
export function usageFromCodexJSONL(data: string): Usage | null {
  let last: CodexTokenUsage | null = null;
  for (const env of parseRollout(data)) {
    if (env.type !== "event_msg") continue;
    const payload = env.payload as
      | { type?: string; info?: { total_token_usage?: CodexTokenUsage } | null }
      | undefined;
    if (!payload || payload.type !== "token_count") continue;
    const usage = payload.info?.total_token_usage;
    if (usage && typeof usage === "object") last = usage;
  }
  if (!last) return null;
  return {
    inputTokens: toCount(last.input_tokens),
    outputTokens: toCount(last.output_tokens),
    cacheReadInputTokens: toCount(last.cached_input_tokens),
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: toCount(last.reasoning_output_tokens),
  };
}
