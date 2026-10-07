import type { PublicKey, Signer } from "@solana/web3.js";

export type AegisEnvironment = "mock" | "localnet" | "devnet";

export interface CreateVaultParams {
  vaultId: bigint;
  agent: PublicKey;
  maxTradeRaw: bigint;
  budgetRaw: bigint;
  expiryUnix: bigint;
}

export interface AegisClient {
  readonly environment: AegisEnvironment;
  getVault(vault: PublicKey): Promise<VaultState>;
  createVault(owner: Signer, p: CreateVaultParams): Promise<TxResult & { vault?: PublicKey }>;
  fundVault(owner: Signer, vault: PublicKey, amountRaw: bigint): Promise<TxResult>;
  swap(agent: Signer, vault: PublicKey, amountInRaw: bigint): Promise<TxResult>;
  revoke(owner: Signer, vault: PublicKey): Promise<TxResult>;
  rotateAgent(owner: Signer, vault: PublicKey, newAgent: PublicKey): Promise<TxResult>;
  withdraw(owner: Signer, vault: PublicKey, mint: PublicKey, amountRaw: bigint): Promise<TxResult>;
  listActivity(vault: PublicKey): Promise<Activity[]>;
}

export interface VaultState {
  address: PublicKey;
  owner: PublicKey;
  agent: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  maxTradeRaw: bigint;
  budgetRaw: bigint;
  spentRaw: bigint;
  expiryUnix: bigint;
  revoked: boolean;
  inputBalanceRaw: bigint;
  outputBalanceRaw: bigint;
}

export interface Activity {
  signature: string;
  slot: bigint;
  blockTime?: bigint;
  ok: boolean;
  error?: string;
}

export type TxResult =
  | { ok: true; signature: string }
  | { ok: false; signature?: string; error: string; origin: "client" | "program" | "rpc" };

/** Caller-selected accounts for attack demonstrations. The agent is supplied separately. */
export interface SwapAccounts {
  vault: PublicKey;
  vaultAuthority: PublicKey;
  inputVault: PublicKey;
  outputVault: PublicKey;
  pool: PublicKey;
  poolAuthority: PublicKey;
  inputReserve: PublicKey;
  outputReserve: PublicKey;
  demoDexProgram: PublicKey;
  tokenProgram: PublicKey;
}
