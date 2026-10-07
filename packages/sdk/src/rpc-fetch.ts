export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_WS_URL = "wss://api.devnet.solana.com";

/** Retry transport failures, never rebuild/re-sign a transaction or retry a program rejection. */
export function devnetFetch(fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetcher(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
        const body = response.ok ? await response.clone().json().catch(() => null) : null;
        const retry = response.status === 429 || response.status >= 500 ||
          [-32603, -32004, -32005, -32016].includes(body?.error?.code);
        if (!retry || attempt === 3) return response;
      } catch (error) {
        if (init?.signal?.aborted || attempt === 3) throw error;
      }
      await response?.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  };
}
