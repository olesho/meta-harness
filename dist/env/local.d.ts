import type { Provisioner } from "./types.ts";
/** Construct the `local` provisioner. `root` defaults to an OS-temp subdir; pass
 *  an explicit root for hermetic tests. */
export declare function local(opts?: {
    root?: string;
}): Provisioner;
//# sourceMappingURL=local.d.ts.map