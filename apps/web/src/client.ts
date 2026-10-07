import { PublicKey, type Signer } from "@solana/web3.js";
import type { AegisClient, AegisEnvironment, LocalnetDeployment, TxResult, VaultState } from "@aegis/sdk";
import { MockAegisClient } from "../../../packages/sdk/src/mock";
import { LocalnetReader } from "./localnet-reader";
import { actionDetail, type ActionDetail } from "./activity";

export interface DashboardConnection {
  environment: AegisEnvironment;
  client: Pick<AegisClient, "getVault" | "listActivity">;
  owner: PublicKey;
  agent: PublicKey;
  initialVault: PublicKey | null;
  create(): Promise<TxResult & { vault?: PublicKey }>;
  fund(vault: PublicKey): Promise<TxResult>;
  revoke(vault: PublicKey): Promise<TxResult>;
  withdraw(vault: PublicKey, mint: PublicKey, amount: bigint): Promise<TxResult>;
  trade?(vault: PublicKey, amount: bigint): Promise<TxResult>;
  readDetail?(signature: string, vault: VaultState): Promise<ActionDetail | undefined>;
}

function mockIdentity(byte: number): Signer {
  // MockAegisClient reads only the public identity. Every other access fails closed.
  const identity = { publicKey: new PublicKey(new Uint8Array(32).fill(byte)) };
  return new Proxy(identity, { get(target, property) {
    if (property === "publicKey") return target.publicKey;
    throw new Error("Mock identities cannot sign transactions.");
  } }) as Signer;
}

async function ownerAction(action: string, body: object = {}): Promise<TxResult & { vault?: string }> {
  const response = await fetch(`/api/owner/${action}`, {
    method: "POST", headers: { "content-type": "application/json", "x-aegis-owner": "localnet" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Owner action failed.");
  return result;
}

export async function connectDashboard(environment: AegisEnvironment): Promise<DashboardConnection> {
  if (environment === "mock") {
    const client = new MockAegisClient();
    const owner = mockIdentity(3);
    const agent = mockIdentity(4);
    return {
      environment, client, owner: owner.publicKey, agent: agent.publicKey, initialVault: null,
      create: () => client.createVault(owner, { vaultId: 0n, agent: agent.publicKey, maxTradeRaw: 50_000_000n,
        budgetRaw: 100_000_000n, expiryUnix: BigInt(Math.floor(Date.now() / 1000)) + 3600n }),
      fund: (vault) => client.fundVault(owner, vault, 1_000_000_000n), revoke: (vault) => client.revoke(owner, vault),
      withdraw: (vault, mint, amount) => client.withdraw(owner, vault, mint, amount),
      trade: (vault, amount) => client.swap(agent, vault, amount),
    };
  }
  const response = await fetch("/api/localnet", { cache: "no-store" });
  if (!response.ok) throw new Error("Cannot connect to localnet. Start pnpm localnet and AEGIS_ENV=localnet pnpm dev.");
  const deployment: LocalnetDeployment & { lastVault: string } = await response.json();
  const client = new LocalnetReader(deployment);
  return {
    environment, client, owner: new PublicKey(deployment.owner), agent: new PublicKey(deployment.agent), initialVault: new PublicKey(deployment.lastVault),
    create: async () => {
      const result = await ownerAction("create");
      return { ...result, ...(result.vault ? { vault: new PublicKey(result.vault) } : { vault: undefined }) };
    },
    fund: () => ownerAction("fund"), revoke: () => ownerAction("revoke"),
    withdraw: (_vault, mint, amount) => ownerAction("withdraw", { mint: mint.toBase58(), amountRaw: amount.toString() }),
    readDetail: async (signature, vault) => {
      const transaction = await client.getTransaction(signature);
      return transaction ? actionDetail(transaction, vault) : undefined;
    },
  };
}
