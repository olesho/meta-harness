export interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningOutputTokens: number;
}
export declare function usageToPublicJSON(u: Usage): Record<string, number>;
export declare function usageFromClaudeJSONL(data: string): Usage | null;
export declare function usageFromCodexJSONL(data: string): Usage | null;
//# sourceMappingURL=usage.d.ts.map