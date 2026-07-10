// Core environment-layer interfaces (design §3, §6).
//
// The two orthogonal axes — a `Provisioner` (WHERE the machine comes from) and a
// `Containment` (WHAT the agent may touch) — meet at the `Workspace` contract: an
// exec + file-transfer transport onto a machine. A `Containment` decorates the
// FULL Workspace contract by contributing a `ContainmentLayer` of primitives; the
// core-owned `compose()` (see ./compose.ts) does the actual decoration so no
// containment ever hand-rolls a Workspace wrapper.
//
// Repo idiom: Go-style `Context` for cancellation/deadlines (imported type-only
// via the sanctioned public seam), throwing methods as the non-nil-error
// analogue, structural capability probing for optional layer primitives.
export {};
//# sourceMappingURL=types.js.map