import { PublicKey, type Signer } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID, deriveVaultAuthorityPda, deriveWithdrawPolicy, MockAegisClient, MOCK_INPUT_MINT, MOCK_OUTPUT_MINT, U64_MAX } from "../src/index";

const identity = (byte: number): Signer => ({
  publicKey: new PublicKey(new Uint8Array(32).fill(byte)),
  get secretKey(): Uint8Array { throw new Error("Mock must not access signing keys"); },
});
const owner = identity(3), agent = identity(4), recipient = identity(5), stranger = identity(6);
const preciseAmount = 9_007_199_254_740_993n;

async function fixture() {
  let now = 100n;
  const client = new MockAegisClient({ now: () => now });
  const created = await client.createVault(owner, { vaultId: 0n, agent: agent.publicKey, maxTradeRaw: 10n, budgetRaw: 100n, expiryUnix: 200n });
  expect(created.ok).toBe(true);
  const vault = created.vault!;
  expect(await client.fundVault(owner, vault, preciseAmount)).toMatchObject({ ok: true });
  return { client, vault, expire: () => { now = 200n; } };
}

describe("withdrawal policy PDA", () => {
  it("uses literal policy seeds and the canonical bump, separated by vault and program", () => {
    const vault = owner.publicKey;
    const expected = PublicKey.findProgramAddressSync([Buffer.from("policy"), vault.toBuffer()], AEGIS_PROGRAM_ID);
    expect(deriveWithdrawPolicy(vault)).toEqual(expected);
    expect(deriveWithdrawPolicy(agent.publicKey)[0]).not.toEqual(expected[0]);
    expect(deriveWithdrawPolicy(vault, DEMO_DEX_PROGRAM_ID)).toEqual(
      PublicKey.findProgramAddressSync([Buffer.from("policy"), vault.toBuffer()], DEMO_DEX_PROGRAM_ID),
    );
    expect(deriveWithdrawPolicy(vault, DEMO_DEX_PROGRAM_ID)[0]).not.toEqual(expected[0]);
  });
});

describe("mock withdrawal policies", () => {
  it.each([1, 2, 3])("sets %s extra addresses once and returns independent policy arrays", async (count) => {
    const f = await fixture();
    expect(await f.client.getWithdrawPolicy(f.vault)).toBeNull();
    const addresses = [recipient.publicKey, stranger.publicKey, identity(7).publicKey].slice(0, count);
    const original = addresses.slice();
    expect(await f.client.setWithdrawAddresses(owner, f.vault, addresses)).toMatchObject({ ok: true });
    addresses[0] = owner.publicKey;
    const expected = { address: deriveWithdrawPolicy(f.vault)[0], vault: f.vault, allowed: original };
    const read = await f.client.getWithdrawPolicy(f.vault);
    expect(read).toEqual(expected);
    read!.allowed.length = 0;
    expect(await f.client.setWithdrawAddresses(owner, f.vault, [identity(8).publicKey])).toMatchObject({ ok: false, error: "AccountAlreadyInUse" });
    expect(await f.client.getWithdrawPolicy(f.vault)).toEqual(expected);
  });

  it.each(["empty", "four", "duplicate", "default", "owner", "agent", "vault", "authority", "non-owner"])("rejects %s and leaves policy unset", async (kind) => {
    const f = await fixture();
    const excluded: Record<string, PublicKey> = { default: PublicKey.default, owner: owner.publicKey, agent: agent.publicKey, vault: f.vault, authority: deriveVaultAuthorityPda(f.vault)[0] };
    const addresses = kind === "empty" ? [] : kind === "four" ? [5, 6, 7, 8].map((byte) => identity(byte).publicKey)
      : kind === "duplicate" ? [recipient.publicKey, recipient.publicKey] : [excluded[kind] ?? recipient.publicKey];
    expect(await f.client.setWithdrawAddresses(kind === "non-owner" ? agent : owner, f.vault, addresses))
      .toMatchObject({ ok: false, error: kind === "non-owner" ? "Unauthorized" : "InvalidAmount" });
    expect(await f.client.getWithdrawPolicy(f.vault)).toBeNull();
  });

  it("withdraws exact bigint amounts from both tokens and to the implicit owner after revoke and expiry", async () => {
    const f = await fixture();
    expect(await f.client.setWithdrawAddresses(owner, f.vault, [recipient.publicKey])).toMatchObject({ ok: true });
    expect(await f.client.swap(agent, f.vault, 1n)).toMatchObject({ ok: true });
    expect(await f.client.revoke(owner, f.vault)).toMatchObject({ ok: true });
    f.expire();
    expect(await f.client.withdrawTo(owner, f.vault, MOCK_INPUT_MINT, recipient.publicKey, preciseAmount - 2n)).toMatchObject({ ok: true });
    expect(await f.client.withdrawTo(owner, f.vault, MOCK_OUTPUT_MINT, recipient.publicKey, 10n)).toMatchObject({ ok: true });
    expect(await f.client.withdrawTo(owner, f.vault, MOCK_INPUT_MINT, owner.publicKey, 1n)).toMatchObject({ ok: true });
    expect(await f.client.getVault(f.vault)).toMatchObject({ inputBalanceRaw: 0n, outputBalanceRaw: 0n, spentRaw: 1n });
    expect(await f.client.getWithdrawPolicy(f.vault)).toMatchObject({ allowed: [recipient.publicKey] });
  });

  it.each(["unset", "non-owner", "recipient", "mint", "zero", "negative", "overflow", "number", "balance"])("rejects withdrawal with %s and preserves balances", async (kind) => {
    const f = await fixture();
    if (kind !== "unset") await f.client.setWithdrawAddresses(owner, f.vault, [recipient.publicKey]);
    const before = await f.client.getVault(f.vault);
    const amounts: Record<string, bigint> = { zero: 0n, negative: -1n, overflow: U64_MAX + 1n, number: 1 as unknown as bigint, balance: preciseAmount + 1n };
    const errors: Record<string, string> = { unset: "AccountNotInitialized", "non-owner": "Unauthorized", recipient: "AccountMismatch", mint: "AccountMismatch", balance: "InsufficientFunds" };
    expect(await f.client.withdrawTo(kind === "non-owner" ? agent : owner, f.vault, kind === "mint" ? stranger.publicKey : MOCK_INPUT_MINT,
      kind === "recipient" ? stranger.publicKey : recipient.publicKey, amounts[kind] ?? 1n))
      .toMatchObject({ ok: false, error: errors[kind] ?? "InvalidAmount" });
    expect(await f.client.getVault(f.vault)).toEqual(before);
    if (kind === "unset") expect(await f.client.withdraw(owner, f.vault, MOCK_INPUT_MINT, 1n)).toMatchObject({ ok: true });
  });
});
