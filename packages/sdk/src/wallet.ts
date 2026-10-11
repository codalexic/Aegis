import { Buffer } from "buffer";
import { ed25519 } from "@noble/curves/ed25519";
import { MessageV0, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor/dist/esm/coder/borsh/instruction.js";
import { convertIdlToCamelCase } from "@coral-xyz/anchor/dist/esm/idl.js";
import { encode as encodeSignature } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import type { Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../../../artifacts/idl/aegis.json";
import { AEGIS_PROGRAM_ID, deriveSwapAccounts, deriveVaultAuthorityPda, deriveVaultPda } from "./addresses";
import { ChainReader } from "./chain-reader";
import { isU64 } from "./amounts";
import { ClientError, RpcError, RPC_RATE_LIMITED, WALLET_REJECTED, isRateLimited, isWalletRejected, failure, transactionErrorName } from "./errors";
import type { CreateVaultParams, TxResult } from "./types";
import { WalletTransaction, type WalletSigner } from "./wallet-transaction";
import { validateWalletMessage } from "./wallet-validation";
import { debugWalletFailure, walletErrorDetail } from "./wallet-diagnostics";
export type { WalletSigner } from "./wallet-transaction";

const associatedTokenProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const schema = convertIdlToCamelCase(idl as Idl);
const coder = new BorshInstructionCoder(schema);
const key = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
function u64(value: bigint) {
  if (!isU64(value)) throw new ClientError("InvalidAmount");
  return new BN(value.toString());
}

/** Owner operations, with instructions built locally and signing delegated to a wallet. */
export class WalletAegisClient extends ChainReader {
  private instruction(name: string, args: object, accounts: Record<string, PublicKey>): TransactionInstruction {
    const definition = schema.instructions.find((instruction) => instruction.name === name)!;
    return { programId: AEGIS_PROGRAM_ID, data: coder.encode(name, args), keys: definition.accounts.map((account) => {
      if (!(account.name in accounts) || "accounts" in account) throw new ClientError("AccountMismatch");
      return key(accounts[account.name], account.writable, account.signer);
    }) };
  }

  async createVault(owner: WalletSigner, p: CreateVaultParams): Promise<TxResult & { vault?: PublicKey }> {
    let vault: PublicKey | undefined;
    const result = await this.send(owner, async () => {
      if (typeof p.expiryUnix !== "bigint" || p.expiryUnix < -(1n << 63n) || p.expiryUnix >= 1n << 63n) throw new ClientError("InvalidAmount");
      const vaultId = u64(p.vaultId);
      [vault] = deriveVaultPda(owner.publicKey, p.vaultId);
      const inputMint = new PublicKey(this.deployment.inputMint), outputMint = new PublicKey(this.deployment.outputMint);
      const accounts = deriveSwapAccounts(vault, inputMint, outputMint);
      return [this.instruction("createVault", { vaultId, agent: p.agent, maxTradeRaw: u64(p.maxTradeRaw), budgetRaw: u64(p.budgetRaw), expiryUnix: new BN(p.expiryUnix.toString()) }, {
        owner: owner.publicKey, vault, vaultAuthority: accounts.vaultAuthority, inputMint, outputMint,
        inputVault: accounts.inputVault, outputVault: accounts.outputVault, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram, systemProgram: PublicKey.default,
      })];
    });
    return result.ok ? { ...result, vault } : result;
  }

  async fundVault(owner: WalletSigner, vault: PublicKey, amount: bigint): Promise<TxResult> {
    return this.send(owner, async () => {
      u64(amount);
      const state = await this.getVault(vault);
      const accounts = deriveSwapAccounts(vault, state.inputMint, state.outputMint);
      // SPL TransferChecked: opcode, little-endian u64, decimals. Amount never passes through number.
      const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = 6;
      return [{ programId: TOKEN_PROGRAM_ID, data, keys: [
        key(getAssociatedTokenAddressSync(state.inputMint, owner.publicKey), true), key(state.inputMint),
        key(accounts.inputVault, true), key(owner.publicKey, false, true), key(vault),
      ] }];
    });
  }

  revoke(owner: WalletSigner, vault: PublicKey): Promise<TxResult> {
    return this.send(owner, async () => [this.instruction("revokeAgent", {}, { owner: owner.publicKey, vault })]);
  }

  withdraw(owner: WalletSigner, vault: PublicKey, mint: PublicKey, amount: bigint): Promise<TxResult> {
    return this.send(owner, async () => {
      const amountRaw = u64(amount), state = await this.getVault(vault);
      if (!mint.equals(state.inputMint) && !mint.equals(state.outputMint)) throw new ClientError("AccountMismatch");
      const authority = deriveVaultAuthorityPda(vault)[0], destination = getAssociatedTokenAddressSync(mint, owner.publicKey);
      return [
        { programId: associatedTokenProgram, data: Buffer.from([1]), keys: [key(owner.publicKey, true, true), key(destination, true),
          key(owner.publicKey), key(mint), key(PublicKey.default), key(TOKEN_PROGRAM_ID)] },
        this.instruction("withdraw", { amountRaw }, { owner: owner.publicKey, vault, vaultAuthority: authority,
          source: getAssociatedTokenAddressSync(mint, authority, true), destination, tokenProgram: TOKEN_PROGRAM_ID }),
      ];
    });
  }

  private async send(owner: WalletSigner, build: () => Promise<TransactionInstruction[]>): Promise<TxResult> {
    let signature: string | undefined;
    let step = "build";
    try {
      const instructions = await build();
      step = "getLatestBlockhash";
      const { value: lifetime } = await this.rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const transaction = new WalletTransaction(MessageV0.compile({ payerKey: owner.publicKey, recentBlockhash: lifetime.blockhash, instructions }));
      const expectedMessage = Buffer.from(transaction.message.serialize());
      step = "simulateTransaction";
      const { value: simulation } = await this.rpc<{ value: { err: unknown; logs?: string[] } }>("simulateTransaction", [Buffer.from(transaction.serialize()).toString("base64"), { encoding: "base64", commitment: "confirmed", sigVerify: false }]);
      if (simulation.err) {
        const error = transactionErrorName(simulation.err, simulation.logs);
        debugWalletFailure(step, "SimulationFailed", error);
        return { ok: false, origin: "program", error };
      }
      let signed;
      step = "wallet.signTransaction";
      try {
        signed = await owner.signTransaction(transaction);
      } catch (error) {
        if (isRateLimited(error)) throw new RpcError(RPC_RATE_LIMITED);
        if (isWalletRejected(error)) throw new ClientError(WALLET_REJECTED);
        throw new ClientError("WalletSigningError", walletErrorDetail(error));
      }
      step = "validateWalletMessage";
      let walletMessage: Uint8Array;
      const expected = MessageV0.deserialize(expectedMessage);
      try {
        walletMessage = new Uint8Array(signed.message.serialize());
        const actual = MessageV0.deserialize(walletMessage);
        if (!Buffer.from(actual.serialize()).equals(Buffer.from(walletMessage))) {
          throw new ClientError("WalletModifiedTransaction", "Wallet returned a noncanonical message.");
        }
        validateWalletMessage(expected, actual);
      } catch (error) {
        if (error instanceof ClientError) throw error;
        throw new ClientError("WalletModifiedTransaction", "Wallet returned an unreadable or unsupported message.");
      }
      step = "verifyWalletSignature";
      let ownerSignature: Uint8Array;
      try {
        if (signed.signatures.length !== 1) throw new Error();
        ownerSignature = new Uint8Array(signed.signatures[0]);
        if (ownerSignature.length !== 64 || !ed25519.verify(ownerSignature, walletMessage, expected.staticAccountKeys[0].toBytes(), { zip215: false })) throw new Error();
      } catch {
        throw new ClientError("InvalidWalletSignature");
      }
      step = "serializeWalletTransaction";
      let submitted: Buffer;
      try {
        submitted = Buffer.from(signed.serialize());
        // Validate the exact bytes returned by the wallet before submitting them.
        if (!submitted.equals(Buffer.from([1, ...ownerSignature, ...walletMessage]))) throw new Error();
      } catch {
        throw new ClientError("WalletModifiedTransaction", "Wallet returned inconsistent transaction bytes.");
      }
      signature = encodeSignature(ownerSignature);
      step = "sendTransaction";
      const returned = await this.rpc<string>("sendTransaction", [submitted.toString("base64"), { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
      if (returned !== signature) throw new ClientError("RpcError");
      for (let attempt = 0; attempt < 120; attempt++) {
        step = "getSignatureStatuses";
        const { value: [status] } = await this.rpc<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
        if (status && ["confirmed", "finalized"].includes(status.confirmationStatus)) {
          if (status.err) {
            const landed = await this.getTransaction(signature).catch(() => null);
            const error = transactionErrorName(status.err, landed?.meta?.logMessages);
            debugWalletFailure(step, "TransactionFailed", error);
            return { ok: false, signature, origin: "program", error };
          }
          return { ok: true, signature };
        }
        step = "getBlockHeight";
        if (await this.rpc<number>("getBlockHeight", [{ commitment: "confirmed" }]) > lifetime.lastValidBlockHeight) throw new ClientError("TransactionExpired");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new ClientError("ConfirmationTimedOut");
    } catch (error) {
      const result = failure(error, signature);
      debugWalletFailure(step, result.error, result.detail);
      return result;
    }
  }
}
