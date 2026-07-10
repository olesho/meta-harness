import type { Provisioner } from "../env/types.ts";
export interface DaytonaConfig {
    /** Daytona API key (from environment or credential store). */
    apiKey?: string;
    /** Daytona API URL override (default: public Daytona SaaS endpoint). */
    apiUrl?: string;
    /** Daytona region/target override (default: auto-selected by Daytona). */
    target?: string;
    /** Optional SDK import override for testing (defaults to @daytonaio/sdk). */
    sdkImport?: string;
}
export declare function daytona(config?: DaytonaConfig): Provisioner;
//# sourceMappingURL=daytona.d.ts.map