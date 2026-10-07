import { readFile } from "node:fs/promises";
import { Keypair, PublicKey, type Signer } from "@solana/web3.js";
import { AnchorAegisClient, MockAegisClient, type LocalnetDeployment, type AegisClient, type SwapAccounts, type TxResult } from "../../packages/sdk/src/index";
import { AgentError } from "./model";

export type AgentClient = AegisClient & {
  swapRaw(agent: Signer, accounts: SwapAccounts, amountRaw: bigint): Promise<TxResult>;
};
export interface AgentContext { client: AgentClient; agent: Signer; vault: PublicKey }

function mockIdentity(byte: number): Signer {
  return {
    publicKey: new PublicKey(new Uint8Array(32).fill(byte)),
    get secretKey(): Uint8Array { throw new AgentError("Mock identities cannot sign transactions."); },
  };
}

export function vaultAddress(value: unknown): PublicKey {
  try {
    if (typeof value !== "string") throw new Error();
    return new PublicKey(value);
  } catch {
    throw new AgentError("Provide a valid --vault address or record lastVault in deployments/localnet.json.");
  }
}

/** Always read only the agent's signing key. */
export async function loadLocalnetAgent(explicitVault?: string): Promise<{ agent: Signer; vault: PublicKey }> {
  let selected: unknown = explicitVault;
  if (!selected) {
    try {
      const deployment = JSON.parse(await readFile(new URL("../../deployments/localnet.json", import.meta.url), "utf8"));
      selected = deployment.lastVault ?? deployment.vaults?.at(-1);
    } catch {
      throw new AgentError("Cannot read deployments/localnet.json; supply --vault or start localnet.");
    }
  }
  const vault = vaultAddress(selected);
  try {
    const bytes: unknown = JSON.parse(await readFile(new URL("../../.keys/agent.json", import.meta.url), "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64 ||
        !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
    return { agent: Keypair.fromSecretKey(Uint8Array.from(bytes)), vault };
  } catch {
    throw new AgentError("Cannot load .keys/agent.json; run pnpm localnet to create a valid test agent key.");
  }
}

export async function createLocalnetContext(explicitVault?: string): Promise<AgentContext> {
  let deployment: LocalnetDeployment & { lastVault?: string; vaults?: string[] };
  try {
    deployment = JSON.parse(await readFile(new URL("../../deployments/localnet.json", import.meta.url), "utf8"));
  } catch { throw new AgentError("Cannot read deployments/localnet.json; start pnpm localnet first."); }
  const selected = explicitVault ?? deployment.lastVault ?? deployment.vaults?.at(-1);
  const identity = await loadLocalnetAgent(vaultAddress(selected).toBase58());
  try {
    if (identity.agent.publicKey.toBase58() !== deployment.agent) throw new Error();
    const client = new AnchorAegisClient({ deployment });
    await client.getVault(identity.vault);
    return { client, ...identity };
  } catch { throw new AgentError("Cannot connect the localnet agent to this vault; create a vault in the dashboard and check the deployment/agent key."); }
}

export async function createMockContext(explicitVault?: string): Promise<AgentContext> {
  const client = new MockAegisClient();
  const owner = mockIdentity(3);
  const agent = mockIdentity(4);
  const created = await client.createVault(owner, {
    vaultId: 0n, agent: agent.publicKey, maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n,
    expiryUnix: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
  });
  if (!created.ok || !created.vault) throw new AgentError("Could not create the mock demo vault.");
  if (explicitVault && !vaultAddress(explicitVault).equals(created.vault)) {
    throw new AgentError("The requested vault is not in this mock session. Omit --vault to use the fresh demo vault.");
  }
  const funded = await client.fundVault(owner, created.vault, 1_000_000_000n);
  if (!funded.ok) throw new AgentError("Could not fund the mock demo vault.");
  return { client, agent, vault: created.vault };
}
