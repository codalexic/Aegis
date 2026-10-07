import { BN, Program, utils, type IdlAccounts } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount,
} from "@solana/spl-token";
import {
  Connection, PublicKey, SystemProgram, Transaction,
  type Signer, type TransactionInstruction,
} from "@solana/web3.js";
import type { Aegis } from "../../../artifacts/idl/aegis";
import aegisIdl from "../../../artifacts/idl/aegis.json";
import localnet from "../../../deployments/localnet.json";
import { AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID, deriveSwapAccounts, deriveVaultAuthorityPda, deriveVaultPda } from "./addresses";
import { isU64 } from "./amounts";
import { ClientError, failure, transactionErrorName } from "./errors";
import type { Activity, AegisClient, CreateVaultParams, SwapAccounts, TxResult, VaultState } from "./types";

export type LocalnetDeployment = typeof localnet;
export interface AnchorClientOptions {
  /** Public addresses only. Pass freshly read JSON after reseeding localnet if needed. */
  deployment?: LocalnetDeployment;
  connection?: Connection;
}
const commitment = "confirmed";
const transactionRead = { commitment, maxSupportedTransactionVersion: 1 } as const;

function requireLocalUrl(value: string, protocol: "http:" | "ws:") {
  const url = new URL(value);
  if (url.protocol !== protocol || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new ClientError("Only loopback localnet endpoints are supported.");
  }
}

function u64(value: bigint): BN {
  // Serialization bounds only; policy checks (including zero) belong to the program.
  if (!isU64(value)) throw new ClientError("InvalidAmount");
  return new BN(value.toString());
}

/** Wallet-free reads; each write signs only with the explicitly supplied signer. */
export class AnchorAegisClient implements AegisClient {
  readonly environment = "localnet" as const;
  readonly connection: Connection;
  private readonly program: Program<Aegis>;
  private readonly inputMint: PublicKey;
  private readonly outputMint: PublicKey;
  private readonly pool: PublicKey;
  private readonly poolAuthority: PublicKey;
  private readonly inputReserve: PublicKey;
  private readonly outputReserve: PublicKey;

  constructor({ deployment = localnet, connection }: AnchorClientOptions = {}) {
    requireLocalUrl(deployment.rpcUrl, "http:");
    requireLocalUrl(deployment.wsUrl, "ws:");
    if (connection) requireLocalUrl(connection.rpcEndpoint, "http:");
    if (deployment.environment !== "localnet" || deployment.programs.aegis !== AEGIS_PROGRAM_ID.toBase58() ||
        deployment.programs.demoDex !== DEMO_DEX_PROGRAM_ID.toBase58()) throw new ClientError("DeploymentProgramMismatch");
    this.connection = connection ?? new Connection(deployment.rpcUrl, { commitment, wsEndpoint: deployment.wsUrl });
    this.program = new Program<Aegis>(aegisIdl as Aegis, { connection: this.connection });
    this.inputMint = new PublicKey(deployment.inputMint);
    this.outputMint = new PublicKey(deployment.outputMint);
    this.pool = new PublicKey(deployment.pool);
    this.poolAuthority = new PublicKey(deployment.poolAuthority);
    this.inputReserve = new PublicKey(deployment.inputReserve);
    this.outputReserve = new PublicKey(deployment.outputReserve);
    const expected = deriveSwapAccounts(PublicKey.default, this.inputMint, this.outputMint);
    if (this.inputMint.equals(this.outputMint) || !this.pool.equals(expected.pool) ||
        !this.poolAuthority.equals(expected.poolAuthority) || !this.inputReserve.equals(expected.inputReserve) ||
        !this.outputReserve.equals(expected.outputReserve)) throw new ClientError("DeploymentAccountMismatch");
  }

  private async readVault(vault: PublicKey): Promise<IdlAccounts<Aegis>["vault"]> {
    const info = await this.connection.getAccountInfo(vault, commitment);
    if (!info) throw new ClientError("VaultNotFound");
    if (!info.owner.equals(AEGIS_PROGRAM_ID) || info.executable || info.data.length !== this.program.account.vault.size) {
      throw new ClientError("AccountMismatch");
    }
    try {
      const state = this.program.coder.accounts.decode<IdlAccounts<Aegis>["vault"]>("vault", info.data);
      const expected = deriveSwapAccounts(vault, state.inputMint, state.outputMint);
      if (!vault.equals(deriveVaultPda(state.owner, BigInt(state.vaultId.toString()))[0]) ||
          !state.inputVault.equals(expected.inputVault) || !state.outputVault.equals(expected.outputVault)) throw new Error();
      return state;
    } catch { throw new ClientError("AccountMismatch"); }
  }

  async getVault(vault: PublicKey): Promise<VaultState> {
    const state = await this.readVault(vault);
    const accounts = await this.connection.getMultipleAccountsInfo([state.inputVault, state.outputVault], commitment);
    let inputBalanceRaw: bigint;
    let outputBalanceRaw: bigint;
    try {
      const [authority] = deriveVaultAuthorityPda(vault);
      const input = unpackAccount(state.inputVault, accounts[0], TOKEN_PROGRAM_ID);
      const output = unpackAccount(state.outputVault, accounts[1], TOKEN_PROGRAM_ID);
      if (!input.isInitialized || !output.isInitialized || !input.owner.equals(authority) || !output.owner.equals(authority) ||
          !input.mint.equals(state.inputMint) || !output.mint.equals(state.outputMint)) throw new Error();
      inputBalanceRaw = input.amount;
      outputBalanceRaw = output.amount;
    } catch { throw new ClientError("AccountMismatch"); }
    return {
      address: vault, owner: state.owner, agent: state.agent, inputMint: state.inputMint, outputMint: state.outputMint,
      maxTradeRaw: BigInt(state.maxTradeRaw.toString()), budgetRaw: BigInt(state.budgetRaw.toString()),
      spentRaw: BigInt(state.spentRaw.toString()), expiryUnix: BigInt(state.expiryUnix.toString()), revoked: state.revoked,
      inputBalanceRaw, outputBalanceRaw,
    };
  }

  async createVault(owner: Signer, p: CreateVaultParams): Promise<TxResult & { vault?: PublicKey }> {
    let vault: PublicKey | undefined;
    const result = await this.send(owner, async () => {
      const id = u64(p.vaultId);
      if (typeof p.expiryUnix !== "bigint" || p.expiryUnix < -(1n << 63n) || p.expiryUnix >= 1n << 63n) throw new ClientError("InvalidAmount");
      [vault] = deriveVaultPda(owner.publicKey, p.vaultId);
      const accounts = deriveSwapAccounts(vault, this.inputMint, this.outputMint);
      return [await this.program.methods.createVault(id, p.agent, u64(p.maxTradeRaw), u64(p.budgetRaw), new BN(p.expiryUnix.toString()))
        .accountsStrict({
          owner: owner.publicKey, vault, vaultAuthority: accounts.vaultAuthority,
          inputMint: this.inputMint, outputMint: this.outputMint, inputVault: accounts.inputVault, outputVault: accounts.outputVault,
          tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).instruction()];
    });
    return result.ok ? { ...result, vault } : result;
  }

  async fundVault(owner: Signer, vault: PublicKey, amountRaw: bigint): Promise<TxResult> {
    return this.send(owner, async () => {
      u64(amountRaw);
      const state = await this.readVault(vault);
      const source = getAssociatedTokenAddressSync(state.inputMint, owner.publicKey);
      const instruction = createTransferCheckedInstruction(source, state.inputMint, state.inputVault, owner.publicKey, amountRaw, 6);
      // A readonly reference makes this plain SPL transfer discoverable by listActivity(vault).
      instruction.keys.push({ pubkey: vault, isSigner: false, isWritable: false });
      return [instruction];
    });
  }

  async swap(agent: Signer, vault: PublicKey, amountInRaw: bigint): Promise<TxResult> {
    try {
      const state = await this.readVault(vault);
      return this.swapRaw(agent, {
        vault, vaultAuthority: deriveVaultAuthorityPda(vault)[0], inputVault: state.inputVault, outputVault: state.outputVault,
        pool: this.pool, poolAuthority: this.poolAuthority, inputReserve: this.inputReserve, outputReserve: this.outputReserve,
        demoDexProgram: DEMO_DEX_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      }, amountInRaw);
    } catch (error) { return failure(error); }
  }

  /** No policy/account prechecks or account resolution; caller-chosen accounts go to the program verbatim. */
  async swapRaw(agent: Signer, accounts: SwapAccounts, amountInRaw: bigint): Promise<TxResult> {
    return this.send(agent, async () => [await this.program.methods.executeSwap(u64(amountInRaw))
      .accountsStrict({ agent: agent.publicKey, ...accounts }).instruction()]);
  }

  async revoke(owner: Signer, vault: PublicKey): Promise<TxResult> {
    return this.send(owner, async () => [await this.program.methods.revokeAgent()
      .accountsStrict({ owner: owner.publicKey, vault }).instruction()]);
  }

  async withdraw(owner: Signer, vault: PublicKey, mint: PublicKey, amountRaw: bigint): Promise<TxResult> {
    return this.send(owner, async () => {
      const amount = u64(amountRaw);
      const state = await this.readVault(vault);
      const source = mint.equals(state.inputMint) ? state.inputVault : mint.equals(state.outputMint) ? state.outputVault : undefined;
      if (!source) throw new ClientError("AccountMismatch");
      const destination = getAssociatedTokenAddressSync(mint, owner.publicKey);
      return [
        createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, destination, owner.publicKey, mint),
        await this.program.methods.withdraw(amount).accountsStrict({
          owner: owner.publicKey, vault, vaultAuthority: deriveVaultAuthorityPda(vault)[0], source, destination, tokenProgram: TOKEN_PROGRAM_ID,
        }).instruction(),
      ];
    });
  }

  private async send(signer: Signer, build: () => Promise<TransactionInstruction[]>): Promise<TxResult> {
    let signature: string | undefined;
    try {
      const instructions = await build();
      const lifetime = await this.connection.getLatestBlockhash(commitment);
      const transaction = new Transaction({ feePayer: signer.publicKey, ...lifetime }).add(...instructions);
      try { transaction.sign(signer); } catch { throw new ClientError("SigningFailed"); }
      signature = utils.bytes.bs58.encode(transaction.signature!);
      // Deliberately land rejected demo transactions so RPC history can show the program's rejection.
      await this.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 3 });
      const confirmation = await this.connection.confirmTransaction({ signature, ...lifetime }, commitment);
      if (confirmation.value.err) {
        // A log lookup outage must not turn a confirmed rejection into a success or an RPC failure.
        const transaction = await this.connection.getTransaction(signature, transactionRead).catch(() => null);
        return { ok: false, signature, origin: "program", error: transactionErrorName(confirmation.value.err, transaction?.meta?.logMessages) };
      }
      return { ok: true, signature };
    } catch (error) { return failure(error, signature); }
  }

  async listActivity(vault: PublicKey): Promise<Activity[]> {
    const activity: Activity[] = [];
    let before: string | undefined;
    for (;;) {
      const signatures = await this.connection.getSignaturesForAddress(vault, { limit: 1000, before }, commitment);
      for (const item of signatures) {
        const transaction = await this.connection.getTransaction(item.signature, transactionRead);
        const err = transaction?.meta?.err ?? item.err;
        activity.push({
          signature: item.signature, slot: BigInt(item.slot),
          ...(item.blockTime != null && { blockTime: BigInt(item.blockTime) }),
          ok: err === null, ...(err !== null && { error: transactionErrorName(err, transaction?.meta?.logMessages) }),
        });
      }
      if (signatures.length < 1000) return activity;
      before = signatures.at(-1)!.signature;
    }
  }
}
