import { ClientError, isBlockhashNotFound, isTransientRpcError, RpcError } from "./errors";
import { beforeDeadline, retryDelay, sleep } from "./retry";

export type TransactionStatus = { err: unknown; confirmationStatus?: string | null; confirmations?: number | null } | null;
export interface SignedTransactionRpc {
  send(): Promise<unknown>;
  status(): Promise<TransactionStatus>;
  height(commitment: "confirmed" | "finalized"): Promise<number>;
  confirm?(signal: AbortSignal): Promise<{ err: unknown }>;
}

/** Only this error authorizes a server signer to create a different signature. */
export class SafeToResign extends ClientError {}
const confirmed = (status: TransactionStatus) => status &&
  (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ||
    (status.confirmationStatus == null && status.confirmations === null));

/** Resubmit identical signed bytes and reconcile their signature before reporting failure.
 * No caller may rebuild after an ambiguous response until finalized expiry + absent history.
 */
export async function sendSignedTransaction(rpc: SignedTransactionRpc, lastValidBlockHeight: number,
  { deadline = Date.now() + 45_000, onRetry }: { deadline?: number; onRetry?: () => void } = {}): Promise<{ err: unknown }> {
  let ambiguous = false, observed = false, sends = 0;
  const call = <T>(operation: () => Promise<T>) => beforeDeadline(operation, Math.min(deadline, Date.now() + 8_000));
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    if (attempt > 0) {
      try {
        const status = await call(() => rpc.status());
        if (confirmed(status)) return { err: status!.err };
        observed ||= status !== null;
        if (await call(() => rpc.height("confirmed")) > lastValidBlockHeight) {
          if (await call(() => rpc.height("finalized")) > lastValidBlockHeight) {
            const finalStatus = await call(() => rpc.status());
            if (confirmed(finalStatus)) return { err: finalStatus!.err };
            if (finalStatus === null) throw new SafeToResign("TransactionExpired");
          }
          // Don't resend an expired blockhash while waiting for finalized expiry.
          await sleep(Math.min(retryDelay(attempt), Math.max(0, deadline - Date.now())));
          continue;
        }
      } catch (error) {
        if (error instanceof SafeToResign || !isTransientRpcError(error)) throw error;
        // A status outage is not proof of failure or expiry. Keep the same signature.
      }
    }
    if (sends < 4 && !observed) {
      const previouslyAmbiguous: boolean = ambiguous;
      ambiguous = true; // A lost response may still have landed.
      sends++;
      try {
        await call(() => rpc.send());
        if (rpc.confirm) {
          const controller = new AbortController();
          try { return await beforeDeadline(() => rpc.confirm!(controller.signal), Math.min(deadline, Date.now() + 1_500)); }
          catch { /* HTTP signature polling also works without a websocket. */ }
          finally { controller.abort(); }
        }
      } catch (error) {
        // A preflight blockhash rejection did not broadcast this attempt.
        if (isBlockhashNotFound(error)) ambiguous = previouslyAmbiguous;
        else if (!isTransientRpcError(error)) {
          // Even a later preflight rejection can follow an earlier successful send.
          const status = await call(() => rpc.status()).catch(() => null);
          if (confirmed(status)) return { err: status!.err };
          if (!previouslyAmbiguous) throw error;
        }
      }
    }
    try {
      const status = await call(() => rpc.status());
      if (confirmed(status)) return { err: status!.err };
      observed ||= status !== null;
      if (await call(() => rpc.height("confirmed")) > lastValidBlockHeight &&
          await call(() => rpc.height("finalized")) > lastValidBlockHeight) {
        // Query history AFTER finalized expiry, not before: closes the landing race.
        const finalStatus = await call(() => rpc.status());
        if (confirmed(finalStatus)) return { err: finalStatus!.err };
        if (finalStatus === null) throw new SafeToResign("TransactionExpired");
      }
    } catch (error) {
      if (error instanceof SafeToResign || !isTransientRpcError(error)) throw error;
    }
    onRetry?.();
    await sleep(Math.min(retryDelay(attempt), Math.max(0, deadline - Date.now())));
  }
  // Preserve ambiguity; callers must check the existing signature, never repeat the payment.
  throw new RpcError("ConfirmationTimedOut");
}
