export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const DEVNET_WS_URL = "wss://api.devnet.solana.com";

/** One browser transport for reads, simulation, submission and confirmation.
 * Serialize requests and share cooldowns so other calls cannot bypass backoff.
 * Retries reuse the original body, including already signed transaction bytes.
 */
export function rateAwareFetch(fetcher: typeof fetch = (...args) => globalThis.fetch(...args)): typeof fetch {
  let tail: Promise<unknown> = Promise.resolve();
  let nextRequestAt = 0;
  const backoff = (attempt: number) => 500 * 2 ** attempt + Math.floor(Math.random() * 250);
  return (input, init) => {
    const request = tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const delay = nextRequestAt - Date.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        init?.signal?.throwIfAborted();
        let response: Response;
        try {
          response = await fetcher(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
        } catch (error) {
          if (init?.signal?.aborted || attempt === 3) throw error;
          nextRequestAt = Date.now() + backoff(attempt);
          continue;
        }
        // Stay below the public endpoint's per-method burst limit on cold activity loads.
        nextRequestAt = Date.now() + 350;
        const body = response.ok ? await response.clone().json().catch(() => null) : null;
        const retry = response.status === 429 || response.status >= 500 ||
          body?.error?.code === 429 || [-32603, -32004, -32005, -32016].includes(body?.error?.code);
        if (!retry) return response;
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds * 1000)
          : retryAfter === null ? 0 : Date.parse(retryAfter);
        nextRequestAt = Math.max(nextRequestAt, Number.isFinite(retryAt) ? retryAt : 0,
          Date.now() + backoff(attempt));
        if (attempt === 3) return response;
        await response.body?.cancel();
      }
    });
    tail = request.catch(() => {});
    return request;
  };
}

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
