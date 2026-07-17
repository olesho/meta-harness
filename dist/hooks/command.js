// Managed-command render + marker recognition (Go analogue: the render/marker
// helpers in pkg/harness/hookensure.go).
//
// A "managed" hook command is one meta-harness itself installed into a config.
// Every rendered command carries a stable trailing marker comment so a later
// ensure/remove pass recognises and rewrites ONLY our own entries — never a
// co-tenant's block (e.g. a Go harness-wrapper block), matching Go's marker
// semantics.
import path from "node:path";
// hookMarkerPrefix tags meta-harness's own hook commands. It is emitted as a
// trailing shell comment (`# <prefix>:<event>`), so it is inert at runtime yet
// unambiguously recognisable. A co-tenant block lacks this exact token and is
// therefore left untouched.
export const hookMarkerPrefix = "meta-harness-hook";
// shq wraps a token in double quotes, escaping the characters the shell would
// otherwise interpret. Sufficient for the filesystem paths we emit.
function shq(s) {
    return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}
// renderHookCommand builds the shell command string installed into settings.
// The Node bin and the committed dist/cli/hooks.js are both pinned, and a
// trailing marker comment tags the entry as ours.
export function renderHookCommand(opts) {
    const { nodePath, distDir, event, args = [] } = opts;
    const hooksJs = path.join(distDir, "cli", "hooks.js");
    const parts = [shq(nodePath), shq(hooksJs), event, ...args.map(shq)];
    return `${parts.join(" ")} # ${hookMarkerPrefix}:${event}`;
}
// isManagedHookCommand reports whether `cmd` is one meta-harness installed,
// i.e. it carries our marker. It never matches a co-tenant's command.
export function isManagedHookCommand(cmd) {
    return cmd.includes(`# ${hookMarkerPrefix}`);
}
//# sourceMappingURL=command.js.map