export const WALLET_REQUEST_FAILED = "Wallet request failed or was declined. Check Phantom and try again.";
export const WALLET_CHANGED = "Wallet changed. Connect again to continue.";

/** Lifecycle failures aren't declined requests, even when an adapter wraps them. */
export function isWalletDisconnected(error: unknown): boolean {
  const seen = new Set<unknown>();
  function check(value: unknown): boolean {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const e = value as { name?: string; cause?: unknown; error?: unknown };
    return ["WalletDisconnectedError", "WalletNotConnectedError", "WalletDisconnectionError", "AbortError"].includes(e.name ?? "")
      || check(e.cause) || check(e.error);
  }
  return check(error);
}
