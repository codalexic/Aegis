import { PublicKey } from "@solana/web3.js";
import { WalletAegisClient, type WalletSigner } from "../../../packages/sdk/src/wallet";
import type { ChainDeployment } from "@aegis/sdk";
import { actionDetail } from "./activity";
import type { DashboardConnection } from "./client";

export async function connectWalletDashboard(environment: "localnet" | "devnet", wallet: WalletSigner): Promise<DashboardConnection> {
  const response = await fetch("/api/deployment", { cache: "no-store" });
  const deployment: ChainDeployment & { error?: string } = await response.json();
  if (!response.ok) throw new Error(deployment.error ?? "Cannot load this cluster's deployment.");
  if (deployment.environment !== environment) throw new Error("Deployment environment mismatch.");
  const client = new WalletAegisClient(deployment), agent = new PublicKey(deployment.agent);
  const create = async () => {
    const slot = await client.rpc<number>("getSlot", [{ commitment: "confirmed" }]);
    const time = await client.rpc<number | null>("getBlockTime", [slot]);
    if (time === null) throw new Error("Chain clock is unavailable.");
    const [vaultId] = crypto.getRandomValues(new BigUint64Array(1));
    return client.createVault(wallet, { vaultId, agent, maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: BigInt(time) + 3600n });
  };
  return {
    environment, walletMode: true, client, owner: wallet.publicKey, agent, initialVault: null,
    create,
    newDemo: async () => {
      const created = await create();
      if (!created.ok || !created.vault) return created;
      const funding = await client.fundVault(wallet, created.vault, 1_000_000_000n);
      return { ...funding, vault: created.vault, createSignature: created.signature,
        ...(!funding.ok && { error: `Vault created, but funding failed: ${funding.error}. Use Fund 1,000 to retry.` }) };
    },
    fund: (vault) => client.fundVault(wallet, vault, 1_000_000_000n),
    revoke: (vault) => client.revoke(wallet, vault),
    withdraw: (vault, mint, amount) => client.withdraw(wallet, vault, mint, amount),
    faucet: async () => {
      const response = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json", "x-aegis-faucet": environment }, body: JSON.stringify({ wallet: wallet.publicKey.toBase58() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Faucet request failed.");
      return "Received 1,000 testUSDC. Your wallet also needs SOL on this cluster for transaction fees.";
    },
    readDetail: async (signature, vault) => {
      const transaction = await client.getTransaction(signature);
      return transaction ? actionDetail(transaction, vault) : undefined;
    },
  };
}
