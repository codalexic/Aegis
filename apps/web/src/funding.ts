import type { PublicKey } from "@solana/web3.js";
import type { DashboardConnection, ProgressCallback } from "./client";

export const DEMO_FUND_RAW = 1_000_000_000n;

export function needsFaucet(balance: bigint | null, hasFaucet: boolean): boolean {
  return hasFaucet && balance !== null && balance < DEMO_FUND_RAW;
}

/** Attempt a balance refresh before unlocking, without replacing a confirmed result. */
export async function withWalletBalanceRefresh<T>(action: () => Promise<T>, refresh: () => Promise<void>): Promise<T> {
  try { return await action(); }
  finally { await refresh().catch(() => {}); }
}

/** One optional read per state poll. Missing ATAs are empty; RPC failures are unknown. */
export async function readWalletBalance(rpcUrl: string, tokenAccount: PublicKey): Promise<bigint | null> {
  try {
    // Read the response directly: the SDK intentionally hides RPC error details, including
    // the missing-account response we need to distinguish from a busy endpoint here.
    const response = await fetch(rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance",
        params: [tokenAccount.toBase58(), { commitment: "confirmed" }] }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (body.error?.code === -32602 && /could not find account/i.test(body.error.message ?? "")) return 0n;
    if (body.error || typeof body.result?.value?.amount !== "string" || !/^\d+$/.test(body.result.value.amount)) return null;
    return BigInt(body.result.value.amount);
  } catch { return null; }
}

export async function newFundedDemo(
  connection: DashboardConnection, balance: bigint | null, refreshWalletBalance: () => Promise<void>,
  onProgress?: ProgressCallback,
) {
  if (needsFaucet(balance, !!connection.faucet)) {
    onProgress?.("Getting testUSDC…");
    await connection.faucet!();
    await refreshWalletBalance();
  }
  onProgress?.("Creating and funding vault…");
  return connection.newDemo(onProgress);
}
