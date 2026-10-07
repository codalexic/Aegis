import { MockAegisClient } from "./mock";
import { AnchorAegisClient, type AnchorClientOptions } from "./anchor";
import type { AegisEnvironment } from "./types";

export * from "./types";
export * from "./amounts";
export * from "./addresses";
export * from "./mock";
export * from "./anchor";

export function createClient(environment: AegisEnvironment, options?: AnchorClientOptions): MockAegisClient | AnchorAegisClient {
  if (environment === "mock") return new MockAegisClient();
  if (environment === "localnet") return new AnchorAegisClient(options);
  throw new Error(`Unsupported client environment: ${environment}.`);
}
