import { Keypair } from "@solana/web3.js";
import { afterEach, expect, it, vi } from "vitest";
import { fixture, instructionCoder } from "./anchor-helpers";
import { walletSvm } from "./wallet-svm";
import { MockAegisClient } from "../src/mock";

afterEach(() => vi.restoreAllMocks());

it("appends the policy to the Anchor creation transaction", async () => {
  const f = await fixture(), addresses = Array.from({ length: 3 }, () => Keypair.generate().publicKey);
  expect(await f.client.createVault(f.owner, { ...f.policy, withdrawAddresses: addresses })).toMatchObject({ ok: true });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].instructions.map((ix) => instructionCoder.decode(ix.data)?.name)).toEqual(["create_vault", "set_withdraw_addresses"]);
  expect(instructionCoder.decode(f.sent[0].instructions[1].data)?.data).toEqual({ addresses });
  expect(f.sent[0].verifySignatures()).toBe(true);
});

it("creates a wallet vault and its three-address policy in one signature", async () => {
  const f = walletSvm(), addresses = Array.from({ length: 3 }, () => Keypair.generate().publicKey);
  expect(await f.client.createVault(f.wallet, { ...f.params, withdrawAddresses: addresses })).toMatchObject({ ok: true });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect((await f.client.getWithdrawPolicy(f.vault))?.allowed).toEqual(addresses);
});

it("wallet creation is atomic when the policy is invalid", async () => {
  const f = walletSvm();
  expect(await f.client.createVault(f.wallet, { ...f.params, withdrawAddresses: [f.params.agent] })).toMatchObject({ ok: false });
  expect(f.sign).not.toHaveBeenCalled();
  await expect(f.client.getVault(f.vault)).rejects.toThrow("VaultNotFound");
  expect(await f.client.getWithdrawPolicy(f.vault)).toBeNull();
});

it("mock creation sets its policy atomically and leaves legacy creation wallet-only", async () => {
  const client = new MockAegisClient(), owner = Keypair.generate(), agent = Keypair.generate().publicKey;
  const params = { vaultId: 1n, agent, maxTradeRaw: 1n, budgetRaw: 10n, expiryUnix: BigInt(Math.floor(Date.now() / 1000)) + 3600n };
  expect(await client.createVault(owner, { ...params, withdrawAddresses: [agent] })).toMatchObject({ ok: false });
  const recipient = Keypair.generate().publicKey;
  const created = await client.createVault(owner, { ...params, withdrawAddresses: [recipient] });
  expect(created.ok).toBe(true);
  expect((await client.getWithdrawPolicy(created.vault!))?.allowed).toEqual([recipient]);
  expect(await client.listActivity(created.vault!)).toHaveLength(2); // Failed attempt, then one atomic create.
  const legacy = await client.createVault(owner, { ...params, vaultId: 2n });
  expect(await client.getWithdrawPolicy(legacy.vault!)).toBeNull();
});
