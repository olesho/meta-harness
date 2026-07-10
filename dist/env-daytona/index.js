// Public barrel for `meta-harness/env-daytona`.
//
// The Daytona provisioner (design §3, §4): elastically-provisioned remote
// sandboxes via the Daytona SDK (@daytonaio/sdk, optional peer dependency).
// The SDK import is lazy/dynamic so this barrel stays SDK-free at load time.
//
// Barrel discipline (enforced by test/exports-guard.test.ts): this file NEVER
// imports from src/internal/** and NEVER runtime-exports `Context`. The
// `Context` type is referenced through the sanctioned public seam
// (`meta-harness/async`); it is erased at runtime.
export { daytona } from "./daytona.js";
export { fileCredentialInjector } from "./file-injector.js";
export { CREDENTIAL_SENSITIVE_ENV_NAMES, credentialLeakProbe, } from "./leak-probe.js";
//# sourceMappingURL=index.js.map