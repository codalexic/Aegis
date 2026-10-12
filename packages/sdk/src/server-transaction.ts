import { Transaction, type Connection, type Signer, type TransactionInstruction } from "@solana/web3.js";
import { encode } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { ClientError, failure, transactionErrorName } from "./errors";
import { beforeDeadline, retryRpc } from "./retry";
import { SafeToResign, sendSignedTransaction } from "./transaction-retry";
import type { TxResult } from "./types";

/** Shared by all server writes, including faucet minting. */
export async function sendServerTransaction(connection: Connection, signer: Signer,
  build: () => Promise<TransactionInstruction[]>, { skipPreflight = false, onRetry }: { skipPreflight?: boolean; onRetry?: () => void } = {}): Promise<TxResult> {
  const deadline = Date.now() + 45_000;
  let signature: string | undefined;
  try {
    const instructions = await retryRpc(build, onRetry, deadline);
    for (let attempt = 0; ; attempt++) {
      const lifetime = await retryRpc(() => connection.getLatestBlockhash("confirmed"), onRetry, deadline);
      const transaction = new Transaction({ feePayer: signer.publicKey, ...lifetime }).add(...instructions);
      try { transaction.sign(signer); } catch { throw new ClientError("SigningFailed"); }
      signature = encode(transaction.signature!);
      const bytes = transaction.serialize(), submittedSignature = signature;
      try {
        const confirmation = await sendSignedTransaction({
          send: () => connection.sendRawTransaction(bytes, { skipPreflight, preflightCommitment: "confirmed", maxRetries: 3 }),
          status: async () => (await connection.getSignatureStatuses([submittedSignature], { searchTransactionHistory: true })).value[0],
          height: (commitment) => connection.getBlockHeight(commitment),
          confirm: async (abortSignal) => (await connection.confirmTransaction({ signature: submittedSignature, ...lifetime, abortSignal }, "confirmed")).value,
        }, lifetime.lastValidBlockHeight, { deadline, onRetry });
        if (confirmation.err) {
          const landed = await beforeDeadline(() => connection.getTransaction(submittedSignature, {
            commitment: "confirmed", maxSupportedTransactionVersion: 1,
          }), Math.min(deadline, Date.now() + 5_000)).catch(() => null);
          return { ok: false, signature, origin: "program", error: transactionErrorName(confirmation.err, landed?.meta?.logMessages) };
        }
        return { ok: true, signature };
      } catch (error) {
        if (!(error instanceof SafeToResign) || attempt >= 2 || Date.now() >= deadline) throw error;
        onRetry?.();
      }
    }
  } catch (error) { return failure(error, signature); }
}
