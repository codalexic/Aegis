import { PublicKey, type Signer } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  createClient, deriveSwapAccounts, deriveVaultPda, MockAegisClient,
  MOCK_INPUT_MINT, MOCK_OUTPUT_MINT, U64_MAX,
  type CreateVaultParams, type TxResult,
} from "@aegis/sdk";

const NOW = 1_800_000_000n;
const FUNDING = 1_000_000_000n;

function identity(byte: number): Signer {
  return {
    publicKey: new PublicKey(new Uint8Array(32).fill(byte)),
    get secretKey(): Uint8Array { throw new Error("The mock must never read signing keys."); },
  };
}

function fixture() {
  let time = NOW;
  return {
    client: new MockAegisClient({ now: () => time }),
    owner: identity(3), agent: identity(4), attacker: identity(5),
    setTime: (value: bigint) => { time = value; },
  };
}

function policy(agent: PublicKey): CreateVaultParams {
  return { vaultId: 0n, agent, maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: NOW + 3_600n };
}

function assertSuccess(result: TxResult) {
  expect(result).toMatchObject({ ok: true, signature: expect.stringMatching(/^mock-[1-9][0-9]*$/) });
}

async function freshVault(overrides: Partial<CreateVaultParams> = {}, funding = FUNDING) {
  const f = fixture();
  const result = await f.client.createVault(f.owner, { ...policy(f.agent.publicKey), ...overrides });
  assertSuccess(result);
  if (!result.vault) throw new Error("Create did not return a vault");
  assertSuccess(await f.client.fundVault(f.owner, result.vault, funding));
  return { ...f, vault: result.vault };
}

async function rejectWithoutChanges(f: Awaited<ReturnType<typeof freshVault>>, run: () => Promise<TxResult>, error: string) {
  const before = await f.client.getVault(f.vault);
  const result = await run();
  expect(result).toMatchObject({ ok: false, error, origin: "client", signature: expect.stringMatching(/^mock-/) });
  // Includes both token balances and spentRaw, plus the complete policy/identity state.
  expect(await f.client.getVault(f.vault)).toEqual(before);
  expect((await f.client.listActivity(f.vault))[0]).toMatchObject({ ok: false, error, signature: result.signature });
}

describe("mock shared cases (INTERFACES §8)", () => {
  it("swaps 20 and credits 200000000 raw output with spent 20000000", async () => {
    const f = await freshVault();
    const before = await f.client.getVault(f.vault);
    assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
    expect(await f.client.getVault(f.vault)).toEqual({
      ...before, inputBalanceRaw: FUNDING - 20_000_000n, outputBalanceRaw: 200_000_000n, spentRaw: 20_000_000n,
    });
  });

  it("permits exactly 50 at the per-trade cap", async () => {
    const f = await freshVault();
    assertSuccess(await f.client.swap(f.agent, f.vault, 50_000_000n));
    expect(await f.client.getVault(f.vault)).toMatchObject({
      inputBalanceRaw: FUNDING - 50_000_000n, outputBalanceRaw: 500_000_000n, spentRaw: 50_000_000n,
    });
  });

  it("rejects 60 with CapExceeded", async () => {
    const f = await freshVault();
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, 60_000_000n), "CapExceeded");
  });

  it("permits five swaps of 20, then rejects the sixth with BudgetExceeded", async () => {
    const f = await freshVault();
    for (let count = 1n; count <= 5n; count++) {
      assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
      expect(await f.client.getVault(f.vault)).toMatchObject({
        spentRaw: count * 20_000_000n,
        inputBalanceRaw: FUNDING - count * 20_000_000n,
        outputBalanceRaw: count * 200_000_000n,
      });
    }
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, 20_000_000n), "BudgetExceeded");
  });

  it("rejects output redirected to an attacker with AccountMismatch", async () => {
    const f = await freshVault();
    const accounts = deriveSwapAccounts(f.vault, MOCK_INPUT_MINT, MOCK_OUTPUT_MINT);
    await rejectWithoutChanges(f, () => f.client.swapRaw(f.agent, {
      ...accounts, outputVault: f.attacker.publicKey,
    }, 20_000_000n), "AccountMismatch");
  });

  it("rejects the wrong swap signer with Unauthorized", async () => {
    const f = await freshVault();
    await rejectWithoutChanges(f, () => f.client.swap(f.attacker, f.vault, 20_000_000n), "Unauthorized");
  });

  it("rejects an agent withdrawal with Unauthorized", async () => {
    const f = await freshVault();
    assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
    await rejectWithoutChanges(f, () => f.client.withdraw(f.agent, f.vault, MOCK_OUTPUT_MINT, 200_000_000n), "Unauthorized");
  });

  it("rejects trading after revocation with Revoked", async () => {
    const f = await freshVault();
    assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
    assertSuccess(await f.client.revoke(f.owner, f.vault));
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, 20_000_000n), "Revoked");
  });

  it.each([0n, 1n])("rejects trading at expiry + %s seconds with Expired", async (offset) => {
    const f = await freshVault();
    f.setTime(NOW + 3_599n);
    assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
    f.setTime(NOW + 3_600n + offset);
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, 20_000_000n), "Expired");
  });

  it.each(["revoked", "expired", "revoked and expired"])("lets the owner withdraw both balances when %s", async (condition) => {
    const f = await freshVault();
    assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
    if (condition.includes("revoked")) assertSuccess(await f.client.revoke(f.owner, f.vault));
    if (condition.includes("expired")) f.setTime(NOW + 3_600n);
    const before = await f.client.getVault(f.vault);
    assertSuccess(await f.client.withdraw(f.owner, f.vault, before.inputMint, before.inputBalanceRaw));
    assertSuccess(await f.client.withdraw(f.owner, f.vault, before.outputMint, before.outputBalanceRaw));
    expect(await f.client.getVault(f.vault)).toEqual({ ...before, inputBalanceRaw: 0n, outputBalanceRaw: 0n });
  });
});

describe("mock state and bounds", () => {
  it("creates the specified state and exposes the mock environment through the factory", async () => {
    const f = await freshVault();
    expect(createClient("mock")).toBeInstanceOf(MockAegisClient);
    expect(createClient("mock").environment).toBe("mock");
    expect(await f.client.getVault(f.vault)).toEqual({
      address: deriveVaultPda(f.owner.publicKey, 0n)[0], owner: f.owner.publicKey, agent: f.agent.publicKey,
      inputMint: MOCK_INPUT_MINT, outputMint: MOCK_OUTPUT_MINT,
      maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, spentRaw: 0n,
      expiryUnix: NOW + 3_600n, revoked: false, inputBalanceRaw: FUNDING, outputBalanceRaw: 0n,
    });
  });

  it.each([
    { maxTradeRaw: 0n }, { budgetRaw: 0n }, { maxTradeRaw: 100_000_001n },
    { maxTradeRaw: U64_MAX + 1n }, { vaultId: -1n }, { vaultId: U64_MAX + 1n },
    { expiryUnix: NOW }, { expiryUnix: NOW - 1n }, { expiryUnix: 1n << 63n },
  ])("rejects invalid policy %s without creating state", async (overrides) => {
    const f = fixture();
    expect(await f.client.createVault(f.owner, { ...policy(f.agent.publicKey), ...overrides }))
      .toMatchObject({ ok: false, error: "InvalidAmount", origin: "client" });
    await expect(f.client.getVault(deriveVaultPda(f.owner.publicKey, 0n)[0])).rejects.toThrow("VaultNotFound");
  });

  it("rejects equal input and output mints", async () => {
    const f = fixture();
    const client = new MockAegisClient({ inputMint: MOCK_INPUT_MINT, outputMint: MOCK_INPUT_MINT, now: () => NOW });
    expect(await client.createVault(f.owner, policy(f.agent.publicKey))).toMatchObject({ ok: false, error: "InvalidAmount" });
    await expect(client.getVault(deriveVaultPda(f.owner.publicKey, 0n)[0])).rejects.toThrow("VaultNotFound");
  });

  it("keeps revocation permanent and prevents duplicate creation from replacing state", async () => {
    const f = await freshVault();
    await rejectWithoutChanges(f, () => f.client.revoke(f.agent, f.vault), "Unauthorized");
    assertSuccess(await f.client.revoke(f.owner, f.vault));
    const before = await f.client.getVault(f.vault);
    assertSuccess(await f.client.revoke(f.owner, f.vault));
    expect(await f.client.getVault(f.vault)).toEqual(before);
    await rejectWithoutChanges(f, () => f.client.createVault(f.owner, policy(f.attacker.publicKey)), "VaultAlreadyExists");
  });

  it.each([0n, -1n, U64_MAX + 1n])("rejects invalid amount %s for funding, swaps and withdrawals", async (amount) => {
    const f = await freshVault();
    await rejectWithoutChanges(f, () => f.client.fundVault(f.owner, f.vault, amount), "InvalidAmount");
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, amount), "InvalidAmount");
    await rejectWithoutChanges(f, () => f.client.withdraw(f.owner, f.vault, MOCK_INPUT_MINT, amount), "InvalidAmount");
  });

  it("rejects insufficient balances and an unrelated withdrawal mint", async () => {
    const f = await freshVault({}, 1n);
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, 20_000_000n), "InsufficientFunds");
    await rejectWithoutChanges(f, () => f.client.withdraw(f.owner, f.vault, MOCK_INPUT_MINT, 2n), "InsufficientFunds");
    await rejectWithoutChanges(f, () => f.client.withdraw(f.owner, f.vault, f.attacker.publicKey, 1n), "AccountMismatch");
    await rejectWithoutChanges(f, () => f.client.fundVault(f.attacker, f.vault, 1n), "Unauthorized");
  });

  it("preserves raw amounts above JavaScript's safe integer range", async () => {
    const amount = 9_007_199_254_740_993n;
    const f = await freshVault({ maxTradeRaw: amount, budgetRaw: amount }, amount);
    assertSuccess(await f.client.swap(f.agent, f.vault, amount));
    expect(await f.client.getVault(f.vault)).toMatchObject({ inputBalanceRaw: 0n, outputBalanceRaw: amount * 10n, spentRaw: amount });
  });

  it("rejects u64 funding and fixed-rate multiplication overflow atomically", async () => {
    const f = await freshVault({ maxTradeRaw: U64_MAX, budgetRaw: U64_MAX }, U64_MAX);
    await rejectWithoutChanges(f, () => f.client.fundVault(f.owner, f.vault, 1n), "InvalidAmount");
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, U64_MAX), "InvalidAmount");
  });

  it("rejects output balance overflow without applying a partial swap", async () => {
    const amount = U64_MAX / 10n;
    const f = await freshVault({ maxTradeRaw: amount, budgetRaw: amount * 2n }, amount * 2n);
    assertSuccess(await f.client.swap(f.agent, f.vault, amount));
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, amount), "SwapResultMismatch");
  });

  it("checks authorization and revocation before later swap errors", async () => {
    const f = await freshVault();
    assertSuccess(await f.client.revoke(f.owner, f.vault));
    f.setTime(NOW + 3_600n);
    await rejectWithoutChanges(f, () => f.client.swap(f.attacker, f.vault, 0n), "Unauthorized");
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, 0n), "Revoked");
  });

  it("records ordered mock-only activity and returns independent state/history copies", async () => {
    const f = await freshVault();
    assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
    await rejectWithoutChanges(f, () => f.client.swap(f.agent, f.vault, 60_000_000n), "CapExceeded");
    const history = await f.client.listActivity(f.vault);
    expect(history.map((item) => item.signature)).toEqual(["mock-4", "mock-3", "mock-2", "mock-1"]);
    expect(history.map((item) => item.slot)).toEqual([4n, 3n, 2n, 1n]);
    expect(history.map((item) => item.ok)).toEqual([false, true, true, true]);
    expect(history.every((item) => item.blockTime === NOW)).toBe(true);
    const state = await f.client.getVault(f.vault);
    state.inputBalanceRaw = 0n;
    history[0].signature = "changed";
    history.length = 0;
    expect((await f.client.getVault(f.vault)).inputBalanceRaw).toBe(FUNDING - 20_000_000n);
    expect((await f.client.listActivity(f.vault))[0].signature).toBe("mock-4");
  });

  it("isolates vault balances and histories", async () => {
    const f = await freshVault();
    const second = await f.client.createVault(f.owner, { ...policy(f.agent.publicKey), vaultId: 1n });
    assertSuccess(second);
    if (!second.vault) throw new Error("Missing second vault");
    const before = await f.client.getVault(second.vault);
    const history = await f.client.listActivity(second.vault);
    assertSuccess(await f.client.swap(f.agent, f.vault, 20_000_000n));
    expect(await f.client.getVault(second.vault)).toEqual(before);
    expect(await f.client.listActivity(second.vault)).toEqual(history);
    await expect(new MockAegisClient().getVault(f.vault)).rejects.toThrow("VaultNotFound");
  });
});
