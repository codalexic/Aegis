import { Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import localnet from "../../../deployments/localnet.json";
import { AnchorAegisClient, createClient, devnetFetch, DEVNET_RPC_URL, DEVNET_WS_URL, explorerTransactionUrl } from "../src/index";

const deployment = { ...localnet, environment: "devnet", rpcUrl: DEVNET_RPC_URL, wsUrl: DEVNET_WS_URL };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("devnet environment isolation", () => {
  it("creates a devnet client only with an explicit devnet deployment", () => {
    const client = createClient("devnet", { deployment });
    expect(client).toBeInstanceOf(AnchorAegisClient);
    expect(client.environment).toBe("devnet");
    expect((client as AnchorAegisClient).connection.rpcEndpoint).toBe(DEVNET_RPC_URL);
    expect(() => createClient("devnet")).toThrow("deployments/devnet.json");
    expect(() => createClient("devnet", { deployment: localnet })).toThrow("deployments/devnet.json");
    expect(() => createClient("localnet", { deployment })).toThrow("must match localnet");
  });

  it.each([
    { rpcUrl: "https://api.mainnet-beta.solana.com" }, { rpcUrl: localnet.rpcUrl },
    { rpcUrl: "https://api.devnet.solana.com.evil.invalid" }, { wsUrl: localnet.wsUrl },
  ])("rejects other endpoints in devnet mode: %s", (overrides) => {
    expect(() => new AnchorAegisClient({ deployment: { ...deployment, ...overrides } })).toThrow("public Solana devnet endpoint");
  });

  it("rejects an injected connection to a different chain", () => {
    expect(() => new AnchorAegisClient({ deployment, connection: new Connection(localnet.rpcUrl) })).toThrow("public Solana devnet endpoint");
    expect(() => new AnchorAegisClient({ deployment: localnet, connection: new Connection(DEVNET_RPC_URL) })).toThrow("loopback");
  });

  it("links devnet transactions to devnet, preserves localnet links, and never links mock signatures", () => {
    expect(explorerTransactionUrl("signature", "devnet")).toBe("https://explorer.solana.com/tx/signature?cluster=devnet");
    expect(explorerTransactionUrl("signature", "localnet")).toBe("https://explorer.solana.com/tx/signature?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899");
    expect(explorerTransactionUrl("mock-1", "mock")).toBeUndefined();
    expect(explorerTransactionUrl("mock-1", "devnet")).toBeUndefined();
    expect(explorerTransactionUrl("a?b", "devnet")).toContain("a%3Fb?cluster=devnet");
  });
});

describe("devnet RPC backoff", () => {
  it("retries HTTP, JSON-RPC and network errors with identical signed transaction bytes", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ error: { code: -32005, message: "Node is unhealthy" } }))
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(Response.json({ result: "signature" }));
    const body = JSON.stringify({ method: "sendTransaction", params: ["unchanged-signed-bytes"] });
    const pending = devnetFetch(fetcher)(DEVNET_RPC_URL, { method: "POST", body });
    await vi.runAllTimersAsync();
    expect(await (await pending).json()).toEqual({ result: "signature" });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url, options]) => url === DEVNET_RPC_URL && options?.body === body)).toBe(true);
  });

  it("stops after four HTTP failures", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("unavailable", { status: 503 }));
    const pending = devnetFetch(fetcher)(DEVNET_RPC_URL);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([400, 401, 403])("does not retry HTTP %s", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("rejected", { status }));
    expect((await devnetFetch(fetcher)(DEVNET_RPC_URL)).status).toBe(status);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry a program simulation failure", async () => {
    const rejection = { error: { code: -32002, data: { err: { InstructionError: [0, { Custom: 6004 }] } } } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(rejection));
    expect(await (await devnetFetch(fetcher)(DEVNET_RPC_URL)).json()).toEqual(rejection);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation without retrying", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("cancelled"));
    await expect(devnetFetch(fetcher)(DEVNET_RPC_URL, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
