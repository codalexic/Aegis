import { randomBytes } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import type { ActionPostResponse } from "@solana/actions";
import type { Aegis } from "../../../../artifacts/idl/aegis";
import idl from "../../../../artifacts/idl/aegis.json";
import { AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID, deriveSwapAccounts, deriveVaultPda, deriveVaultAuthorityPda } from "../../../../packages/sdk/src/addresses";
import { uiAmountToRaw } from "../../../../packages/sdk/src/amounts";
import type { ChainDeployment } from "../../../../packages/sdk/src/anchor";

const { Program, BN } = (Reflect.get(anchor, "default") ?? anchor) as typeof anchor;
export type ActionName = "create" | "fund" | "revoke" | "withdraw";
export class ActionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function walletAddress(value: unknown): PublicKey {
  try {
    if (typeof value !== "string" || value.length > 44) throw new Error();
    const key = new PublicKey(value);
    if (key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes())) throw new Error();
    return key;
  } catch { throw new ActionError(400, "Provide a valid signing wallet account."); }
}
export function positiveAmount(value: unknown, label: string): bigint {
  try {
    if (typeof value !== "string" || value.length > 30) throw new Error();
    const amount = uiAmountToRaw(value, 6);
    if (amount === 0n) throw new Error();
    return amount;
  } catch { throw new ActionError(400, `${label} must be a positive testUSDC decimal string with at most 6 decimal places, within u64 range.`); }
}

/** Public deployment and RPC only. This service never loads keys, signs, or sends. */
export class ActionsService {
  readonly program: anchor.Program<Aegis>;
  readonly inputMint: PublicKey;
  readonly outputMint: PublicKey;
  readonly agent: PublicKey;
  constructor(readonly deployment: ChainDeployment, readonly connection: Connection) {
    if (connection.rpcEndpoint !== deployment.rpcUrl || deployment.programs.aegis !== AEGIS_PROGRAM_ID.toBase58() ||
        deployment.programs.demoDex !== DEMO_DEX_PROGRAM_ID.toBase58()) throw new ActionError(503, "Action deployment mismatch.");
    this.inputMint = new PublicKey(deployment.inputMint); this.outputMint = new PublicKey(deployment.outputMint);
    this.agent = walletAddress(deployment.agent);
    const expected = deriveSwapAccounts(PublicKey.default, this.inputMint, this.outputMint);
    if (this.inputMint.equals(this.outputMint) || (["pool", "poolAuthority", "inputReserve", "outputReserve"] as const)
      .some((key) => expected[key].toBase58() !== deployment[key])) throw new ActionError(503, "Action pool configuration mismatch.");
    this.program = new Program<Aegis>(idl as Aegis, { connection });
  }

  async readVault(address: PublicKey, owner: PublicKey) {
    const info = await this.connection.getAccountInfo(address, "confirmed");
    if (!info) throw new ActionError(404, "Vault no longer exists on the configured chain.");
    try {
      if (!info.owner.equals(AEGIS_PROGRAM_ID) || info.executable || info.data.length !== this.program.account.vault.size) throw new Error();
      const state = this.program.coder.accounts.decode<anchor.IdlAccounts<Aegis>["vault"]>("vault", info.data);
      const expected = deriveSwapAccounts(address, this.inputMint, this.outputMint);
      if (!state.owner.equals(owner) || !state.inputMint.equals(this.inputMint) || !state.outputMint.equals(this.outputMint) ||
          !deriveVaultPda(owner, BigInt(state.vaultId.toString()))[0].equals(address) ||
          !state.inputVault.equals(expected.inputVault) || !state.outputVault.equals(expected.outputVault)) throw new Error();
      return state;
    } catch { throw new ActionError(400, "Vault accounts do not match this wallet and deployment."); }
  }

  /** Newest successful creation in RPC history, not the largest random vault ID or last HTTP request. */
  async latestVault(owner: PublicKey): Promise<PublicKey | null> {
    const create = idl.instructions.find((instruction) => instruction.name === "create_vault")!;
    let before: string | undefined;
    for (;;) {
      const history = await this.connection.getSignaturesForAddress(owner, { limit: 100, before }, "confirmed");
      for (const item of history) {
        if (item.err) continue;
        const tx = await this.connection.getTransaction(item.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
        // Missing history cannot safely identify an older vault as the latest one.
        if (!tx) throw new ActionError(503, "Recent wallet history is unavailable. Retry when the RPC has indexed it.");
        if (tx.meta?.err) continue;
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
        for (const instruction of [...tx.transaction.message.compiledInstructions].reverse()) {
          if (!keys.get(instruction.programIdIndex)?.equals(AEGIS_PROGRAM_ID) ||
              !Buffer.from(instruction.data).subarray(0, 8).equals(Buffer.from(create.discriminator))) continue;
          const account = (name: string) => keys.get(instruction.accountKeyIndexes[create.accounts.findIndex((account) => account.name === name)]);
          if (!account("owner")?.equals(owner) || !account("input_mint")?.equals(this.inputMint) || !account("output_mint")?.equals(this.outputMint)) continue;
          const vault = account("vault");
          if (!vault) throw new ActionError(503, "Invalid vault creation in RPC history.");
          await this.readVault(vault, owner);
          return vault;
        }
      }
      if (history.length < 100) return null;
      before = history.at(-1)!.signature;
    }
  }

  async build(action: ActionName, owner: PublicKey, values: Record<string, unknown>): Promise<ActionPostResponse> {
    const instructions: TransactionInstruction[] = [];
    let message: string;
    if (action === "create") {
      const cap = positiveAmount(values.cap === undefined || values.cap === "" ? "50" : values.cap, "Per-trade cap");
      const budget = positiveAmount(values.budget === undefined || values.budget === "" ? "100" : values.budget, "Total budget");
      if (cap > budget) throw new ActionError(400, "Per-trade cap must not exceed total budget.");
      if (owner.equals(this.agent)) throw new ActionError(400, "The owner and configured agent must be different wallets.");
      const chainTime = await this.connection.getBlockTime(await this.connection.getSlot("confirmed"));
      if (chainTime === null) throw new ActionError(503, "Chain time is unavailable. Try again.");
      const vaultId = randomBytes(8).readBigUInt64LE(), vault = deriveVaultPda(owner, vaultId)[0];
      const accounts = deriveSwapAccounts(vault, this.inputMint, this.outputMint);
      instructions.push(await this.program.methods.createVault(new BN(vaultId.toString()), this.agent,
        new BN(cap.toString()), new BN(budget.toString()), new BN((BigInt(chainTime) + 3600n).toString())).accountsStrict({
        owner, vault, vaultAuthority: accounts.vaultAuthority, inputMint: this.inputMint, outputMint: this.outputMint,
        inputVault: accounts.inputVault, outputVault: accounts.outputVault, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction());
      message = `Create Aegis vault ${vault.toBase58()} on ${this.deployment.environment}. Valid for one hour; test tokens only.`;
    } else {
      const amount = action === "fund" ? positiveAmount(values.amount, "Funding amount") : undefined;
      const vault = await this.latestVault(owner);
      if (!vault) throw new ActionError(404, "No confirmed vault for this wallet. Create an Aegis vault first.");
      const state = await this.readVault(vault, owner);
      if (action === "fund") {
        const transfer = createTransferCheckedInstruction(getAssociatedTokenAddressSync(this.inputMint, owner), this.inputMint, state.inputVault, owner, amount!, 6);
        transfer.keys.push({ pubkey: vault, isSigner: false, isWritable: false });
        instructions.push(transfer);
      } else if (action === "revoke") {
        instructions.push(await this.program.methods.revokeAgent().accountsStrict({ owner, vault }).instruction());
      } else {
        const authority = deriveVaultAuthorityPda(vault)[0];
        const sources = [state.inputVault, state.outputVault];
        const infos = await this.connection.getMultipleAccountsInfo(sources, "confirmed");
        for (const [index, mint] of [this.inputMint, this.outputMint].entries()) {
          let balance: bigint;
          try {
            const token = unpackAccount(sources[index], infos[index], TOKEN_PROGRAM_ID);
            if (!token.isInitialized || !token.owner.equals(authority) || !token.mint.equals(mint)) throw new Error();
            balance = token.amount;
          } catch { throw new ActionError(400, "Vault token accounts do not match the deployment."); }
          if (balance === 0n) continue;
          const destination = getAssociatedTokenAddressSync(mint, owner);
          instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, mint),
            await this.program.methods.withdraw(new BN(balance.toString())).accountsStrict({
              owner, vault, vaultAuthority: authority, source: sources[index], destination, tokenProgram: TOKEN_PROGRAM_ID,
            }).instruction());
        }
        if (!instructions.length) throw new ActionError(400, "The latest vault is already empty.");
      }
      message = `${action === "fund" ? `Fund ${values.amount} testUSDC into` : action === "revoke" ? "Revoke the agent for" : "Withdraw all available tokens from"} vault ${vault.toBase58()} on ${this.deployment.environment}.`;
    }
    const lifetime = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: lifetime.blockhash, instructions }).compileToV0Message());
    // Explicit serialization avoids createPostResponse's automatic environment-key signing/identity feature.
    return { type: "transaction", transaction: Buffer.from(transaction.serialize()).toString("base64"), message };
  }
}
