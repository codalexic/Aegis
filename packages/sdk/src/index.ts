import { MockAegisClient } from "./mock";
import type { AegisClient, AegisEnvironment } from "./types";

export * from "./types";
export * from "./amounts";
export * from "./addresses";
export * from "./mock";

export function createClient(environment: AegisEnvironment): AegisClient {
  if (environment === "mock") return new MockAegisClient();
  throw new Error(`Unsupported client environment: ${environment}.`);
}
