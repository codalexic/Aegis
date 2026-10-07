import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertRejected, assertSuccess, confirmOptions, connectLocalnet, freshVault,
  FUNDING, nextBlockhash, snapshot, tokenBalance, TRADE, type Fixture, type LocalnetContext,
} from "./helpers";

// INTERFACES §8, except expiry: the real clock is left alone (P6 tests expiry in LiteSVM).
describe("AnchorAegisClient on localnet", () => {
  let context: LocalnetContext;
  let f: Fixture;
  beforeAll(async () => { context = await connectLocalnet(); });
  beforeEach(async () => { f = await freshVault(context); });

  it("normal swap 20 moves real tokens, records spent and appears in activity", async () => {
    const before = await snapshot(f);
    const signature = assertSuccess(await f.client.swap(f.agent, f.vault, TRADE));
    expect(await snapshot(f)).toEqual({
      vault: { ...before.vault, inputBalanceRaw: FUNDING - TRADE, outputBalanceRaw: 200_000_000n, spentRaw: TRADE },
      inputReserve: before.inputReserve + TRADE, outputReserve: before.outputReserve - 200_000_000n,
    });
    await expect.poll(async () => (await f.client.listActivity(f.vault)).find((item) => item.signature === signature))
      .toMatchObject({ signature, ok: true, slot: expect.any(BigInt) });
  });

  it("accepts 50 at the exact per-trade cap", async () => {
    assertSuccess(await f.client.swap(f.agent, f.vault, 50_000_000n));
    expect(await f.client.getVault(f.vault)).toMatchObject({
      inputBalanceRaw: 950_000_000n, outputBalanceRaw: 500_000_000n, spentRaw: 50_000_000n,
    });
  });

  it("rejects 60 with CapExceeded and unchanged state", async () => {
    await assertRejected(f, "CapExceeded", () => f.client.swap(f.agent, f.vault, 60_000_000n));
  });

  it("accepts five distinct swaps of 20, then rejects the sixth with BudgetExceeded", async () => {
    const signatures = new Set<string>();
    for (let i = 1n; i <= 5n; i++) {
      const signature = assertSuccess(await f.client.swap(f.agent, f.vault, TRADE));
      signatures.add(signature);
      expect(await f.client.getVault(f.vault)).toMatchObject({
        inputBalanceRaw: FUNDING - i * TRADE, outputBalanceRaw: i * 200_000_000n, spentRaw: i * TRADE,
      });
      await nextBlockhash(f, signature);
    }
    expect(signatures.size).toBe(5);
    await assertRejected(f, "BudgetExceeded", () => f.client.swap(f.agent, f.vault, TRADE));
  });

  it("rejects output redirected via swapRaw to a real attacker token account", async () => {
    // The agent acts as attacker; this is a valid initialized account for the correct mint.
    const attacker = await getOrCreateAssociatedTokenAccount(f.client.connection, f.owner, f.outputMint,
      f.agent.publicKey, false, "confirmed", confirmOptions);
    const before = await tokenBalance(f, attacker.address);
    await assertRejected(f, "AccountMismatch", () => f.client.swapRaw(f.agent,
      { ...f.accounts, outputVault: attacker.address }, TRADE));
    expect(await tokenBalance(f, attacker.address)).toBe(before);
  });

  it("rejects the wrong swap signer with Unauthorized and unchanged state", async () => {
    await assertRejected(f, "Unauthorized", () => f.client.swap(f.owner, f.vault, TRADE));
  });

  it("rejects agent withdrawal with Unauthorized and unchanged state", async () => {
    const destination = await getOrCreateAssociatedTokenAccount(f.client.connection, f.owner, f.inputMint,
      f.agent.publicKey, false, "confirmed", confirmOptions);
    const before = await tokenBalance(f, destination.address);
    await assertRejected(f, "Unauthorized", () => f.client.withdraw(f.agent, f.vault, f.inputMint, TRADE));
    expect(await tokenBalance(f, destination.address)).toBe(before);
  });

  it("rejects a swap after owner revocation with Revoked and unchanged state", async () => {
    assertSuccess(await f.client.revoke(f.owner, f.vault));
    expect((await f.client.getVault(f.vault)).revoked).toBe(true);
    await assertRejected(f, "Revoked", () => f.client.swap(f.agent, f.vault, TRADE));
  });

  it("lets the owner withdraw both token balances after revocation", async () => {
    assertSuccess(await f.client.swap(f.agent, f.vault, TRADE));
    assertSuccess(await f.client.revoke(f.owner, f.vault));
    const before = await f.client.getVault(f.vault);
    expect(before.revoked).toBe(true);
    const ownerInputBefore = await tokenBalance(f, f.ownerInput);
    const ownerOutputBefore = await tokenBalance(f, f.ownerOutput);
    assertSuccess(await f.client.withdraw(f.owner, f.vault, f.inputMint, before.inputBalanceRaw));
    assertSuccess(await f.client.withdraw(f.owner, f.vault, f.outputMint, before.outputBalanceRaw));
    expect(await f.client.getVault(f.vault)).toEqual({ ...before, inputBalanceRaw: 0n, outputBalanceRaw: 0n });
    expect(await tokenBalance(f, f.ownerInput)).toBe(ownerInputBefore + before.inputBalanceRaw);
    expect(await tokenBalance(f, f.ownerOutput)).toBe(ownerOutputBefore + before.outputBalanceRaw);
  });
});
