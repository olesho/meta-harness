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
import { parseFromBytes } from "./parse.js";
import { TypeAssistant } from "./line.js";
import { parseRollout } from "./codex/parseCodex.js";
// usageToPublicJSON maps Usage onto the snake_case wire shape, mirroring the
// harnesses' own field naming (Anthropic-style cache_* keys).
export function usageToPublicJSON(u) {
    return {
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        cache_read_input_tokens: u.cacheReadInputTokens,
        cache_creation_input_tokens: u.cacheCreationInputTokens,
        reasoning_output_tokens: u.reasoningOutputTokens,
    };
}
function toCount(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}
// usageFromClaudeJSONL sums per-API-call usage across a Claude Code session
// transcript. Claude writes one JSONL line per content block, so several lines
// can share one API call's message id AND repeat its usage — each call is
// counted once (dedup key: message.id, falling back to the line uuid). Returns
// null when no line carries usage (e.g. a transcript from a version that did
// not record it).
export function usageFromClaudeJSONL(data) {
    const seen = new Set();
    let found = false;
    const total = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
    };
    for (const line of parseFromBytes(data)) {
        if (line.type !== TypeAssistant)
            continue;
        const msg = line.message;
        const usage = msg?.usage;
        if (!usage || typeof usage !== "object")
            continue;
        const key = typeof msg?.id === "string" && msg.id !== ""
            ? msg.id
            : "line:" + line.uuid;
        if (seen.has(key))
            continue;
        seen.add(key);
        found = true;
        total.inputTokens += toCount(usage.input_tokens);
        total.outputTokens += toCount(usage.output_tokens);
        total.cacheReadInputTokens += toCount(usage.cache_read_input_tokens);
        total.cacheCreationInputTokens += toCount(usage.cache_creation_input_tokens);
    }
    return found ? total : null;
}
// usageFromCodexJSONL reads the session totals from a Codex rollout: the last
// `token_count` event's `info.total_token_usage` is cumulative, so only that
// one counts. Returns null when the rollout has no token_count with usage info
// (info can legitimately be null on early events).
export function usageFromCodexJSONL(data) {
    let last = null;
    for (const env of parseRollout(data)) {
        if (env.type !== "event_msg")
            continue;
        const payload = env.payload;
        if (!payload || payload.type !== "token_count")
            continue;
        const usage = payload.info?.total_token_usage;
        if (usage && typeof usage === "object")
            last = usage;
    }
    if (!last)
        return null;
    return {
        inputTokens: toCount(last.input_tokens),
        outputTokens: toCount(last.output_tokens),
        cacheReadInputTokens: toCount(last.cached_input_tokens),
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: toCount(last.reasoning_output_tokens),
    };
}
//# sourceMappingURL=usage.js.map