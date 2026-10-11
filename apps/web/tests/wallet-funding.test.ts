import { afterEach, expect, it, vi } from "vitest";
import { walletSvm } from "../../../packages/sdk/tests/wallet-svm";
import { WalletAegisClient } from "../../../packages/sdk/src/wallet";
import { connectWalletDashboard } from "../src/wallet-client";
import { describeError } from "../src/errors";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(balance = 1_000_000_000n) {
  const f = walletSvm(balance);
  vi.spyOn(WalletAegisClient.prototype, "rpc").mockImplementation(f.rpc);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/deployment") return Response.json(f.deployment);
    if (url.startsWith("/api/actions/latest-vault")) return Response.json({ vault: null });
    throw new Error(`Unexpected request: ${url}`);
  }));
  const dashboard = await connectWalletDashboard("localnet", f.wallet);
  return { ...f, dashboard };
}

it("creates twice through the wallet dashboard with distinct random vault IDs", async () => {
  const f = await fixture();
  const progress = vi.fn();
  const first = await f.dashboard.create(progress), second = await f.dashboard.create();
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(first.vault!.equals(second.vault!)).toBe(false);
  expect((await f.dashboard.client.getVault(first.vault!)).owner).toEqual(f.owner.publicKey);
  expect((await f.dashboard.client.getVault(second.vault!)).owner).toEqual(f.owner.publicKey);
  expect(f.sign).toHaveBeenCalledTimes(2);
  // The second action has no listener: callbacks must not leak between actions.
  expect(progress.mock.calls.map(([stage]) => stage)).toEqual([
    "Preparing…", "Approve in Phantom…", "Confirming on Solana…", "Done",
  ]);
});

it("creates, funds, and explains a second fund without another wallet request", async () => {
  const f = await fixture();
  const created = await f.dashboard.create();
  expect(created.ok).toBe(true);
  expect(await f.dashboard.fund(created.vault!)).toMatchObject({ ok: true });
  const second = await f.dashboard.fund(created.vault!);
  expect(second).toEqual({ ok: false, error: "InsufficientFunds", origin: "client" });
  if (second.ok) throw new Error("Expected insufficient balance");
  expect(describeError(second.error).text).toBe("Not enough testUSDC in your wallet. Get 1,000 testUSDC first.");
  expect(f.sign).toHaveBeenCalledTimes(2);
});

it("retains the created vault and friendly explanation when New demo has no tokens", async () => {
  const f = await fixture(0n);
  const result = await f.dashboard.newDemo();
  expect(result).toMatchObject({ ok: false, vault: expect.anything(), createSignature: expect.any(String), origin: "client" });
  if (result.ok) throw new Error("Expected insufficient balance");
  expect(describeError(result.error).text).toContain("Not enough testUSDC in your wallet.");
  expect((await f.dashboard.client.getVault(result.vault!)).inputBalanceRaw).toBe(0n);
  expect(f.sign).toHaveBeenCalledTimes(1);
});
