import { afterEach, expect, it, vi } from "vitest";
import { rateAwareFetch } from "../src/rpc-fetch";
import { ChainReader } from "../src/chain-reader";
import { failure, RPC_RATE_LIMITED } from "../src/errors";
import deployment from "../../../deployments/devnet.json";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shares 429 Retry-After cooldown with queued reads and retries identical bytes", async () => {
  vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("limit", { status: 429, headers: { "Retry-After": "3" } }))
    .mockImplementation(async () => Response.json({ result: "ok" }));
  const fetch = rateAwareFetch(fetcher);
  const pending = fetch(deployment.rpcUrl, { method: "POST", body: "signed-bytes" });
  const read = fetch(deployment.rpcUrl, { method: "POST", body: "read" });
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.slice(0, 2).map(([, init]) => init?.body)).toEqual(["signed-bytes", "signed-bytes"]);
  await vi.advanceTimersByTimeAsync(350);
  await Promise.all([pending, read]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("backs off exponentially with jitter on 5xx and stops after four attempts", async () => {
  vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("unavailable", { status: 503 }));
  const pending = rateAwareFetch(fetcher)(deployment.rpcUrl);
  await vi.advanceTimersByTimeAsync(624); expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1125); expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2125); expect(fetcher).toHaveBeenCalledTimes(4);
  expect((await pending).status).toBe(503);
});

it("honors HTTP-date Retry-After and keeps the cooldown after exhausted retries", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("limit", {
    status: 429, headers: { "Retry-After": new Date(Date.now() + 10_000).toUTCString() },
  }));
  const fetch = rateAwareFetch(fetcher);
  const pending = fetch(deployment.rpcUrl);
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await pending).status).toBe(429);
  const next = fetch(deployment.rpcUrl);
  await vi.advanceTimersByTimeAsync(9999); expect(fetcher).toHaveBeenCalledTimes(4);
  fetcher.mockImplementation(async () => Response.json({ result: "ok" }));
  await vi.advanceTimersByTimeAsync(1); await next;
  expect(fetcher).toHaveBeenCalledTimes(5);
});

it.each([400, 401, 403])("does not retry HTTP %s", async (status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status }));
  expect((await rateAwareFetch(fetcher)(deployment.rpcUrl)).status).toBe(status);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("does not retry program rejections", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: -32002 } }));
  await rateAwareFetch(fetcher)(deployment.rpcUrl);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("retries a network interruption without changing the submitted bytes", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("network unavailable"))
    .mockResolvedValueOnce(Response.json({ result: "signature" }));
  const pending = rateAwareFetch(fetcher)(deployment.rpcUrl, { method: "POST", body: "same-signed-bytes" });
  await vi.runAllTimersAsync();
  expect(await (await pending).json()).toEqual({ result: "signature" });
  expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual(["same-signed-bytes", "same-signed-bytes"]);
});

it("maps exhausted browser 429s to an RPC rate limit, without leaking provider text", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private provider context", { status: 429 })));
  const pending = new ChainReader(deployment).rpc("getLatestBlockhash", []).catch(failure);
  await vi.runAllTimersAsync();
  expect(await pending).toEqual({ ok: false, origin: "rpc", error: RPC_RATE_LIMITED });
});

it("uses a configured public HTTPS endpoint without changing the deployment", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }))
    .mockImplementation(async () => Response.json({ result: 42 }));
  vi.stubGlobal("fetch", fetcher);
  const client = new ChainReader(deployment, { devnetRpcUrl: "https://devnet.example.org/rpc" });
  const pending = client.rpc("getSlot", []);
  await vi.runAllTimersAsync();
  expect(await pending).toBe(42);
  expect(fetcher.mock.calls[0][0]).toBe("https://devnet.example.org/rpc");
  expect(client.deployment.rpcUrl).toBe("https://api.devnet.solana.com");
  expect(() => new ChainReader(deployment, { devnetRpcUrl: "http://example.org" })).toThrow("InvalidDevnetRpcUrl");
});

it("rejects a configured endpoint for another cluster before any other RPC", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: "another-cluster" }));
  vi.stubGlobal("fetch", fetcher);
  const client = new ChainReader(deployment, { devnetRpcUrl: "https://rpc.example.org" });
  await expect(client.rpc("getLatestBlockhash", [])).rejects.toThrow("DeploymentClusterMismatch");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
