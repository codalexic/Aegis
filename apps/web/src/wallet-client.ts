import { PublicKey } from "@solana/web3.js";
import { WalletAegisClient, type WalletSigner } from "../../../packages/sdk/src/wallet";
import type { ChainDeployment, TxResult } from "@aegis/sdk";
import { NO_DEVNET_SOL } from "../../../packages/sdk/src/wallet-errors";
import { actionDetail } from "./activity";
import type { DashboardConnection } from "./client";
import { getAssociatedTokenAddressSync } from "./browser-token";
import { readWalletBalance } from "./funding";

export async function connectWalletDashboard(environment: "localnet" | "devnet", wallet: WalletSigner): Promise<DashboardConnection> {
  const response = await fetch("/api/deployment", { cache: "no-store" });
  const deployment: ChainDeployment & { error?: string } = await response.json();
  if (!response.ok) throw new Error(deployment.error ?? "Cannot load this cluster's deployment.");
  if (deployment.environment !== environment) throw new Error("Deployment environment mismatch.");
  const client = new WalletAegisClient(deployment, { devnetRpcUrl: import.meta.env.VITE_DEVNET_RPC_URL }), agent = new PublicKey(deployment.agent);
  const latestResponse = await fetch(`/api/actions/latest-vault?account=${wallet.publicKey.toBase58()}`, { cache: "no-store" });
  const latest: { vault?: string | null; message?: string } = await latestResponse.json();
  if (!latestResponse.ok) throw new Error(latest.message ?? "Cannot find the wallet's latest vault.");
  const getWalletSolBalance = async (): Promise<bigint | null> => {
    try {
      const { value } = await client.rpc<{ value: unknown }>("getBalance", [wallet.publicKey.toBase58(), { commitment: "confirmed" }]);
      // JSON RPC encodes lamports as an integer. Reject lossy/malformed values.
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
    } catch { return null; }
  };
  const withSol = async <T extends TxResult>(need: bigint, action: () => Promise<T>): Promise<T | Extract<TxResult, { ok: false }>> => {
    const balance = environment === "devnet" ? await getWalletSolBalance() : null;
    if (balance !== null && balance < need) return { ok: false, error: NO_DEVNET_SOL, origin: "client" };
    return action();
  };
  // Conservative estimates: creation includes vault + token-account rent.
  const create = () => withSol(10_000_000n, async () => {
    const slot = await client.rpc<number>("getSlot", [{ commitment: "confirmed" }]);
    const time = await client.rpc<number | null>("getBlockTime", [slot]);
    if (time === null) throw new Error("Chain clock is unavailable.");
    const [vaultId] = crypto.getRandomValues(new BigUint64Array(1));
    return client.createVault(wallet, { vaultId, agent, maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: BigInt(time) + 3600n });
  });
  const fund = (vault: PublicKey) => withSol(100_000n, () => client.fundVault(wallet, vault, 1_000_000_000n));
  return {
    environment, walletMode: true, client, owner: wallet.publicKey, agent, initialVault: latest.vault ? new PublicKey(latest.vault) : null,
    ...(environment === "devnet" && { getWalletSolBalance }),
    getWalletBalance: () => readWalletBalance(environment === "devnet"
      ? import.meta.env.VITE_DEVNET_RPC_URL || deployment.rpcUrl : deployment.rpcUrl,
    getAssociatedTokenAddressSync(new PublicKey(deployment.inputMint), wallet.publicKey)),
    create,
    newDemo: async () => {
      const created = await create();
      if (!created.ok || !created.vault) return created;
      const funding = await fund(created.vault);
      return { ...funding, vault: created.vault, createSignature: created.signature,
        ...(!funding.ok && { error: `Vault created, but funding failed: ${funding.error}. Use Fund 1,000 to retry.` }) };
    },
    fund,
    revoke: (vault) => withSol(100_000n, () => client.revoke(wallet, vault)),
    withdraw: (vault, mint, amount) => withSol(100_000n, () => client.withdraw(wallet, vault, mint, amount)),
    faucet: async () => {
      const response = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json", "x-aegis-faucet": environment }, body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }) });
      const result = await response.json().catch(() => ({ error: response.status === 429
        ? "Faucet request limit reached. Wait before retrying."
        : "Faucet is temporarily unavailable. Check your token balance before retrying." }));
      if (!response.ok) throw new Error(result.error ?? "Faucet request failed.");
      return "Received 1,000 testUSDC. Your wallet also needs SOL on this cluster for transaction fees.";
    },
    readDetail: async (signature, vault) => {
      const transaction = await client.getTransaction(signature);
      return transaction ? actionDetail(transaction, vault) : undefined;
    },
  };
}
