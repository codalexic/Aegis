import { isTransientRpcError, RpcError } from "./errors";

export const retryDelay = (attempt: number) => Math.min(400 * 2 ** attempt, 3000) + Math.floor(Math.random() * 250);
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Also bounds transports which never settle. A timed-out send is always ambiguous. */
export async function beforeDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new RpcError("ConfirmationTimedOut");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RpcError("ConfirmationTimedOut")), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

/** For reads/builds before signing only; never wrap an entire wallet/send operation. */
export async function retryRpc<T>(operation: () => Promise<T>, onRetry?: () => void, deadline = Date.now() + 15_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await beforeDeadline(operation, deadline); }
    catch (error) {
      const delay = retryDelay(attempt);
      if (!isTransientRpcError(error) || attempt >= 3 || Date.now() + delay >= deadline) throw error;
      onRetry?.();
      await sleep(delay);
    }
  }
}
