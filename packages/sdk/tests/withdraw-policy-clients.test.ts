import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { createMintToInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import idl from "../../../artifacts/idl/aegis.json";
import { assertSuccess, send, tokenAccount } from "../../../tests/program/helpers";
import { AEGIS_PROGRAM_ID, deriveWithdrawPolicy, U64_MAX } from "../src/index";
import { fixture, info, instructionCoder, PRECISE_AMOUNT } from "./anchor-helpers";
import { walletSvm } from "./wallet-svm";

const coder = new BorshAccountsCoder(idl as Idl);
afterEach(() => vi.restoreAllMocks());

describe("Anchor withdrawal policy instructions", () => {
  it("sets addresses with only the owner's signature and canonical policy accounts", async () => {
    const f = await fixture();
    const addresses = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    expect(await f.client.setWithdrawAddresses(f.owner, f.vault, addresses)).toMatchObject({ ok: true });
    const tx = f.sent[0], ix = tx.instructions[0];
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.signatures.map(({ publicKey }) => publicKey)).toEqual([f.owner.publicKey]);
    expect(instructionCoder.decode(ix.data)).toEqual({ name: "set_withdraw_addresses", data: { addresses } });
    expect(ix.keys.map(({ pubkey }) => pubkey)).toEqual([f.owner.publicKey, f.vault, deriveWithdrawPolicy(f.vault)[0], SystemProgram.programId]);
    expect(f.getAccountInfo).not.toHaveBeenCalled();
  });

  it.each(["input", "output"])("builds a precise %s withdrawal to the recipient ATA after revoke/expiry", async (side) => {
    const f = await fixture();
    await f.setVault({ revoked: true, expiry_unix: f.raw.spent_raw });
    const recipient = Keypair.generate().publicKey, mint = side === "input" ? f.inputMint : f.outputMint;
    expect(await f.client.withdrawTo(f.owner, f.vault, mint, recipient, PRECISE_AMOUNT)).toMatchObject({ ok: true });
    const [ata, ix] = f.sent[0].instructions;
    const destination = getAssociatedTokenAddressSync(mint, recipient);
    expect(ata.keys[1].pubkey).toEqual(destination);
    expect(ata.keys[2].pubkey).toEqual(recipient);
    expect(instructionCoder.decode(ix.data)?.name).toBe("withdraw_to");
    expect(ix.data.readBigUInt64LE(8)).toBe(PRECISE_AMOUNT);
    expect(ix.keys.map(({ pubkey }) => pubkey)).toEqual([
      f.owner.publicKey, f.vault, deriveWithdrawPolicy(f.vault)[0], f.accounts.vaultAuthority,
      side === "input" ? f.accounts.inputVault : f.accounts.outputVault, destination, TOKEN_PROGRAM_ID,
    ]);
    expect(f.sent[0].verifySignatures()).toBe(true);
  });

  it.each([-1n, U64_MAX + 1n, 1 as unknown as bigint])("rejects unrepresentable withdrawal %s before signing", async (amount) => {
    const f = await fixture();
    expect(await f.client.withdrawTo(f.owner, f.vault, f.inputMint, f.owner.publicKey, amount)).toEqual({ ok: false, error: "InvalidAmount", origin: "client" });
    expect(f.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe.each(["anchor", "wallet"] as const)("%s policy reads", (kind) => {
  it.each(["absent", "valid", "owner", "executable", "length", "discriminator", "vault", "bump", "zero-count", "large-count"])("handles %s accounts", async (variant) => {
    const f = await fixture();
    const [policy, bump] = deriveWithdrawPolicy(f.vault);
    const recipient = Keypair.generate().publicKey;
    let data = await coder.encode("WithdrawPolicy", {
      vault: variant === "vault" ? f.owner.publicKey : f.vault,
      allowed: [recipient, PublicKey.default, PublicKey.default],
      count: variant === "zero-count" ? 0 : variant === "large-count" ? 4 : 1,
      bump: variant === "bump" ? (bump + 1) % 256 : bump,
    });
    if (variant === "length") data = data.subarray(0, data.length - 1);
    if (variant === "discriminator") data.fill(0, 0, 8);
    const account = variant === "absent" ? null : { ...info(data, variant === "owner" ? TOKEN_PROGRAM_ID : AEGIS_PROGRAM_ID), executable: variant === "executable" };
    f.getAccountInfo.mockResolvedValue(account);
    const wallet = walletSvm();
    wallet.rpc.mockResolvedValue({ value: account ? { ...account, owner: account.owner.toBase58(), data: [data.toString("base64"), "base64"] } : null });
    const client = kind === "anchor" ? f.client : wallet.client;
    const result = client.getWithdrawPolicy(f.vault);
    if (variant === "absent") await expect(result).resolves.toBeNull();
    else if (variant === "valid") await expect(result).resolves.toEqual({ address: policy, vault: f.vault, allowed: [recipient] });
    else await expect(result).rejects.toThrow("AccountMismatch");
    if (kind === "anchor") expect(f.getAccountInfo).toHaveBeenCalledWith(policy, "confirmed");
    else expect(wallet.rpc).toHaveBeenCalledWith("getAccountInfo", [policy.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
  });
});

describe("wallet withdrawal policies through LiteSVM", () => {
  it("sets once, reads back, and transfers both tokens with exact amounts after revocation/expiry", async () => {
    const f = walletSvm(PRECISE_AMOUNT);
    const recipient = Keypair.generate().publicKey;
    expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
    expect(await f.client.fundVault(f.wallet, f.vault, PRECISE_AMOUNT)).toMatchObject({ ok: true });
    expect(await f.client.getWithdrawPolicy(f.vault)).toBeNull();
    expect(await f.client.setWithdrawAddresses(f.wallet, f.vault, [recipient])).toMatchObject({ ok: true });
    expect(await f.client.getWithdrawPolicy(f.vault)).toEqual({ address: deriveWithdrawPolicy(f.vault)[0], vault: f.vault, allowed: [recipient] });
    expect(await f.client.setWithdrawAddresses(f.wallet, f.vault, [Keypair.generate().publicKey])).toMatchObject({ ok: false, error: "AccountAlreadyInUse" });
    assertSuccess(send(f.svm, [createMintToInstruction(f.outputMint, f.outputVault, f.owner.publicKey, 10n)], [f.owner]));
    expect(await f.client.revoke(f.wallet, f.vault)).toMatchObject({ ok: true });
    const clock = f.svm.getClock(); clock.unixTimestamp = f.params.expiryUnix; f.svm.setClock(clock);
    expect(await f.client.withdrawTo(f.wallet, f.vault, f.inputMint, recipient, PRECISE_AMOUNT - 1n)).toMatchObject({ ok: true });
    expect(await f.client.withdrawTo(f.wallet, f.vault, f.outputMint, recipient, 10n)).toMatchObject({ ok: true });
    expect(await f.client.withdrawTo(f.wallet, f.vault, f.inputMint, f.owner.publicKey, 1n)).toMatchObject({ ok: true });
    expect(tokenAccount(f.svm, getAssociatedTokenAddressSync(f.inputMint, recipient)).amount).toBe(PRECISE_AMOUNT - 1n);
    expect(tokenAccount(f.svm, getAssociatedTokenAddressSync(f.outputMint, recipient)).amount).toBe(10n);
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(1n);
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(0n);
    expect(tokenAccount(f.svm, f.outputVault).amount).toBe(0n);
  });

  it("surfaces program validation failures without asking the wallet to sign", async () => {
    const f = walletSvm();
    expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
    const signed = f.sign.mock.calls.length;
    expect(await f.client.setWithdrawAddresses(f.wallet, f.vault, [])).toMatchObject({ ok: false, error: "InvalidAmount", origin: "program" });
    expect(f.sign).toHaveBeenCalledTimes(signed);
    expect(await f.client.setWithdrawAddresses(f.wallet, f.vault, [Keypair.generate().publicKey])).toMatchObject({ ok: true });
    expect(await f.client.withdrawTo(f.wallet, f.vault, f.inputMint, Keypair.generate().publicKey, 1n)).toMatchObject({ ok: false, error: "AccountMismatch", origin: "program" });
    expect(f.sign).toHaveBeenCalledTimes(signed + 1);
  });
});
