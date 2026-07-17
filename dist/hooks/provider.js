// Provider surface for harness hook streams. A HookProvider knows how to
// (a) ensure a harness's on-disk hook configuration exists (config-ensure) and
// (b) parse the harness's native hook payloads into canonical transcript
// Event[] (payload-parsing). These are the shared shapes the adapter-capability
// and CLI subtasks build on; the Claude concrete provider lives in claude.ts.
// specFromProfile resolves a StaticHookProfile against a concrete config path
// into an installable HookSpec.
export function specFromProfile(profile, configPath) {
    return {
        configPath,
        events: profile.entries.slice(),
        yield: profile.yield,
        owner: profile.owner,
    };
}
//# sourceMappingURL=provider.js.map