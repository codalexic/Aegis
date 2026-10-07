import { MockAegisClient } from "./mock";
import { AnchorAegisClient, type AnchorClientOptions } from "./anchor";
import type { AegisEnvironment } from "./types";

export * from "./types";
export * from "./amounts";
export * from "./addresses";
export * from "./mock";
export * from "./anchor";
export * from "./devnet";
export * from "./explorer";

export function createClient(environment: AegisEnvironment, options?: AnchorClientOptions): MockAegisClient | AnchorAegisClient {
  if (environment === "mock") return new MockAegisClient();
  if (environment === "localnet") {
    if (options?.deployment && options.deployment.environment !== "localnet") throw new Error("Deployment environment must match localnet.");
    return new AnchorAegisClient(options);
  }
  if (environment === "devnet") {
    if (options?.deployment?.environment !== "devnet") throw new Error("Pass deployments/devnet.json after pnpm devnet:deploy succeeds.");
    return new AnchorAegisClient(options);
  }
  throw new Error(`Unsupported client environment: ${environment}.`);
}
