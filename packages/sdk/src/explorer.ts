import type { AegisEnvironment } from "./types";

export function explorerTransactionUrl(signature: string, environment: AegisEnvironment): string | undefined {
  if (environment === "mock" || signature.startsWith("mock-")) return undefined;
  const cluster = environment === "devnet" ? "cluster=devnet"
    : "cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899";
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?${cluster}`;
}
