import { PublicKey } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
import { walletSvm } from "../../../packages/sdk/tests/wallet-svm";
import { WalletAegisClient } from "../../../packages/sdk/src/wallet";
import { DEVNET_RPC_URL, DEVNET_WS_URL } from "../../../packages/sdk/src/devnet";
import { connectWalletDashboard } from "../src/wallet-client";
import { describeError, NO_DEVNET_SOL_MESSAGE } from "../src/errors";
import { DEVNET_GUIDANCE } from "../src/wallet-lifecycle";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("recovers from a preflight blockhash miss without asking Phantom to sign again", async () => {
  vi.useFakeTimers();
  const f = walletSvm();
  let failSend = true, accepted = false;
  const submissions: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/deployment") return Response.json({ ...f.deployment, environment: "devnet", rpcUrl: DEVNET_RPC_URL, wsUrl: DEVNET_WS_URL });
    if (url.startsWith("/api/actions/latest-vault")) return Response.json({ vault: null });
    const { method, params } = JSON.parse(init!.body as string);
    if (method === "getSignatureStatuses" && !accepted) return Response.json({ result: { value: [null] } });
    if (method === "getBlockHeight") return Response.json({ result: 10 });
    if (method === "sendTransaction") {
      submissions.push(params[0]);
      if (failSend) {
        failSend = false;
        return Response.json({ error: { message: "Transaction simulation failed: Blockhash not found", data: { err: "BlockhashNotFound", logs: [] } } });
      }
      accepted = true;
    }
    return Response.json({ result: method === "getBalance" ? { value: 10_000_000 } : await f.rpc(method, params) });
  }));
  const dashboard = await connectWalletDashboard("devnet", f.wallet);
  const progress = vi.fn(), pending = dashboard.create(progress);
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ ok: true });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toBe(submissions[1]);
  expect(progress).toHaveBeenCalledWith("Network busy, retrying…");
});

async function fixture(lamports: unknown = 10_000_000) {
  const f = walletSvm();
  const balance = vi.fn(async () => {
    if (lamports instanceof Error) throw lamports;
    return { value: lamports };
  });
  const rpc = vi.spyOn(WalletAegisClient.prototype, "rpc").mockImplementation(async (method, params) => {
    return method === "getBalance" ? balance() : f.rpc(method, params);
  });
  const fetcher = vi.fn(async (url: string) => {
    if (url === "/api/deployment") return Response.json({ ...f.deployment, environment: "devnet", rpcUrl: DEVNET_RPC_URL, wsUrl: DEVNET_WS_URL });
    if (url.startsWith("/api/actions/latest-vault")) return Response.json({ vault: null });
    if (url === "/api/faucet") return Response.json({ signature: "test-faucet-response" });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const dashboard = await connectWalletDashboard("devnet", f.wallet);
  return { ...f, dashboard, balance, rpc, fetcher };
}

it.each([0, 9_999_999])("blocks create at %s lamports with friendly copy before Phantom", async (balance) => {
  const f = await fixture(balance);
  const result = await f.dashboard.create();
  expect(result).toEqual({ ok: false, origin: "client", error: "NoDevnetSol" });
  expect(describeError(!result.ok && result.error)).toMatchObject({ text: NO_DEVNET_SOL_MESSAGE, faucet: true });
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.rpc.mock.calls).toEqual([["getBalance", [f.owner.publicKey.toBase58(), { commitment: "confirmed" }]]]);
});

it.each(["newDemo", "fund", "revoke", "withdraw"] as const)("blocks %s before Phantom when SOL is too low", async (action) => {
  const f = await fixture(99_999);
  const result = action === "newDemo" ? await f.dashboard.newDemo()
    : action === "withdraw" ? await f.dashboard.withdraw(f.vault, f.inputMint, 1n)
    : await f.dashboard[action](f.vault);
  expect(result).toMatchObject({ ok: false, error: "NoDevnetSol" });
  expect(f.balance).toHaveBeenCalledTimes(1);
  expect(f.sign).not.toHaveBeenCalled();
  expect(f.rpc).toHaveBeenCalledTimes(1);
});

it.each([new Error("RPC unavailable"), null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("allows create when the SOL balance is unknown: %s", async (balance) => {
  const f = await fixture(balance);
  expect(await f.dashboard.create()).toMatchObject({ ok: true, vault: expect.any(PublicKey) });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.balance).toHaveBeenCalledTimes(1);
});

it("allows create at the estimate and rechecks once before funding a new demo", async () => {
  const f = await fixture();
  expect(await f.dashboard.newDemo()).toMatchObject({ ok: true });
  expect(f.balance).toHaveBeenCalledTimes(2);
  expect(f.sign).toHaveBeenCalledTimes(2);
});

it("keeps a created vault when SOL becomes too low for the funding transaction", async () => {
  const f = await fixture();
  f.balance.mockResolvedValueOnce({ value: 10_000_000 }).mockResolvedValueOnce({ value: 0 });
  const result = await f.dashboard.newDemo();
  expect(result).toMatchObject({ ok: false, vault: expect.any(PublicKey), createSignature: expect.any(String) });
  expect(describeError(!result.ok && result.error)).toMatchObject({ faucet: true });
  expect(f.balance).toHaveBeenCalledTimes(2);
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it("allows fee-only operations at 0.0001 SOL", async () => {
  const f = await fixture();
  const created = await f.dashboard.create();
  f.balance.mockResolvedValue({ value: 100_000 });
  expect(await f.dashboard.fund(created.vault!)).toMatchObject({ ok: true });
  expect(await f.dashboard.revoke(created.vault!)).toMatchObject({ ok: true });
  expect(await f.dashboard.withdraw(created.vault!, f.inputMint, 1_000_000_000n)).toMatchObject({ ok: true });
  expect(f.sign).toHaveBeenCalledTimes(4);
  expect(f.balance).toHaveBeenCalledTimes(4);
});

it("lets a zero-SOL wallet use the server-paid testUSDC faucet without a SOL check or signature", async () => {
  const f = await fixture(0);
  expect(await f.dashboard.getWalletSolBalance!()).toBe(0n);
  f.balance.mockClear();
  expect(await f.dashboard.faucet!()).toContain("Received 1,000 testUSDC");
  expect(f.fetcher.mock.calls.some(([url]) => url === "/api/faucet")).toBe(true);
  expect(f.balance).not.toHaveBeenCalled();
  expect(f.sign).not.toHaveBeenCalled();
});
