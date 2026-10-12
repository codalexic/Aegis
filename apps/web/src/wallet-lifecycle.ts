import { isWalletRejected } from "../../../packages/sdk/src/errors";
import { walletErrorDetail } from "../../../packages/sdk/src/wallet-diagnostics";

export const DEVNET_GUIDANCE = "Make sure Phantom is set to Solana Devnet: Settings → Developer Settings → Testnet Mode → Solana Devnet.";
export const WALLET_REQUEST_FAILED = `Phantom could not complete the request. ${DEVNET_GUIDANCE}`;
export const WALLET_CANCELLED = "Connection cancelled in Phantom.";
export const WALLET_CHANGED = "Wallet changed. Connect again to continue.";

/** Display copy only: Phantom does not expose its selected cluster. */
export function walletRequestError(error: unknown): Error & { detail: string } {
  return Object.assign(new Error(isWalletRejected(error) ? WALLET_CANCELLED : WALLET_REQUEST_FAILED), {
    detail: walletErrorDetail(error),
  });
}

/** Lifecycle failures aren't declined requests, even when an adapter wraps them. */
export function isWalletDisconnected(error: unknown): boolean {
  return hasWalletError(error, ["WalletDisconnectedError", "WalletNotConnectedError", "WalletDisconnectionError", "AbortError"]);
}

export function isWalletNotReady(error: unknown): boolean {
  return hasWalletError(error, ["WalletNotReadyError"]);
}

function hasWalletError(error: unknown, names: string[]): boolean {
  const seen = new Set<unknown>();
  function check(value: unknown): boolean {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const e = value as { name?: string; cause?: unknown; error?: unknown };
    return names.includes(e.name ?? "")
      || check(e.cause) || check(e.error);
  }
  return check(error);
}
