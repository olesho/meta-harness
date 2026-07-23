import type { Event } from "../event.ts";
import { type Usage } from "../usage.ts";
export declare class CodexReader {
    sessionsRoot: string;
    constructor(sessionsRoot?: string);
    read(harnessSessionID: string, _workingDir?: string): Event[];
    readUsage(harnessSessionID: string, _workingDir?: string): Usage | null;
    locateLatestSession(workingDir: string): string | undefined;
    /**
     * resolveRoot — explicit sessionsRoot → $CODEX_HOME/sessions → ~/.codex/sessions.
     *
     * The CODEX_HOME rung exists because codex's session log moves with an
     * ISOLATED CODEX_HOME (the containment mechanism behind the "Approve for me"
     * permission preset): without it a run under an isolated home silently reads
     * the user's global root and reports an empty transcript with null usage.
     *
     * It is what makes src/cli/structured-runner.ts's module-level readTranscript
     * / readUsage correct — they construct `new CodexReader()` with NO root. That
     * is COMPLETE for the one-shot CLI path by construction (re-verified against
     * the current code): the runner's only env source is
     * `cleanEnv(buildGuestEnv(process.env, …))`, and neither step can introduce a
     * key — buildGuestEnv forwards the host env verbatim (it only ever overwrites
     * IS_SANDBOX) and cleanEnv merely drops CLAUDECODE / CLAUDE_CODE_*. So any
     * CODEX_HOME that reaches the child is by definition also in the runner's own
     * environment, where this fallback sees it.
     *
     * DOCUMENTED LIMIT: an isolated home supplied only through `Options.env` —
     * i.e. never exported into the host process — is invisible here, because
     * readTranscript / readUsage take no root parameter. Such a run reads the
     * default root and returns an empty transcript. Widening those exported
     * signatures is deliberately out of scope; callers that isolate via
     * Options.env should construct CodexReader with an explicit sessionsRoot (the
     * route CodexAdapter takes).
     */
    resolveRoot(): string;
    private locate;
}
//# sourceMappingURL=codex.d.ts.map