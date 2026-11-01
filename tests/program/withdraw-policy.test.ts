import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import { address } from "@solana/kit";
import { createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  accountData, AEGIS_ID, aegisIdl, assertProgramError, assertSuccess, createVaultInstruction,
  freshVault, FUNDING, instruction, revokeInstruction, send, snapshotVault, tokenAccount,
  withdrawInstruction, type Fixture,
} from "./helpers";

const coder = new BorshAccountsCoder(aegisIdl);
const policyPda = (vault: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("policy"), vault.toBuffer()], AEGIS_ID);

function setAddresses(f: Fixture, addresses: PublicKey[], owner = f.owner.publicKey) {
  return instruction("set_withdraw_addresses", { addresses }, {
    owner, vault: f.vault, policy: policyPda(f.vault)[0], system_program: SystemProgram.programId,
  });
}

function withdrawTo(f: Fixture, amount = 1n, overrides: Record<string, PublicKey> = {}) {
  return instruction("withdraw_to", { amount_raw: new BN(amount.toString()) }, {
    owner: f.owner.publicKey, vault: f.vault, policy: policyPda(f.vault)[0], vault_authority: f.authority,
    source: f.inputVault, destination: f.ownerInput, token_program: TOKEN_PROGRAM_ID, ...overrides,
  });
}

function withPolicy() {
  const f = freshVault();
  const recipients = Array.from({ length: 3 }, () => Keypair.generate().publicKey);
  assertSuccess(send(f.svm, [setAddresses(f, recipients)], [f.owner]));
  return { ...f, recipients };
}

function recipientAccount(f: Fixture, recipient: PublicKey, mint = f.inputMint) {
  const destination = getAssociatedTokenAddressSync(mint, recipient, true);
  assertSuccess(send(f.svm, [createAssociatedTokenAccountInstruction(f.owner.publicKey, destination, recipient, mint)], [f.owner]));
  return destination;
}

describe("immutable withdrawal policy", () => {
  it.each([1, 2, 3])("sets %s recipients once without changing the vault layout or state", (count) => {
    const f = freshVault();
    const before = snapshotVault(f);
    const addresses = Array.from({ length: count }, () => Keypair.generate().publicKey);
    const [policy, bump] = policyPda(f.vault);
    assertSuccess(send(f.svm, [setAddresses(f, addresses)], [f.owner]));
    const data = accountData(f.svm, policy);
    expect(data).toHaveLength(8 + 32 + 3 * 32 + 1 + 1);
    expect(coder.decode("WithdrawPolicy", data)).toEqual({
      vault: f.vault, allowed: [...addresses, ...Array(3 - count).fill(PublicKey.default)], count, bump,
    });
    expect(send(f.svm, [setAddresses(f, [Keypair.generate().publicKey])], [f.owner])).toBeInstanceOf(FailedTransactionMetadata);
    expect(accountData(f.svm, policy)).toEqual(data);
    expect(snapshotVault(f)).toEqual(before);
    // The legacy owner-only instruction still needs no policy account.
    assertSuccess(send(f.svm, [withdrawInstruction(f, 1n)], [f.owner]));
  });

  it("requires the vault owner", () => {
    const f = freshVault();
    assertProgramError(send(f.svm, [setAddresses(f, [Keypair.generate().publicKey], f.agent.publicKey)], [f.agent]), "Unauthorized");
    expect(f.svm.getAccount(address(policyPda(f.vault)[0].toBase58())).exists).toBe(false);
  });

  it.each(["empty", "four", "duplicate", "default", "owner", "agent", "vault", "authority"])("rejects %s recipients atomically with InvalidAmount", (kind) => {
    const f = freshVault();
    const valid = Keypair.generate().publicKey;
    const excluded: Record<string, PublicKey> = { default: PublicKey.default, owner: f.owner.publicKey, agent: f.agent.publicKey, vault: f.vault, authority: f.authority };
    const addresses = kind === "empty" ? [] : kind === "four" ? Array.from({ length: 4 }, () => Keypair.generate().publicKey)
      : kind === "duplicate" ? [valid, valid] : [valid, excluded[kind]];
    const before = snapshotVault(f);
    assertProgramError(send(f.svm, [setAddresses(f, addresses)], [f.owner]), "InvalidAmount");
    expect(snapshotVault(f)).toEqual(before);
    expect(f.svm.getAccount(address(policyPda(f.vault)[0].toBase58())).exists).toBe(false);
    assertSuccess(send(f.svm, [setAddresses(f, [valid])], [f.owner]));
  });
});

describe("withdraw_to", () => {
  it.each([0, 1, 2])("withdraws both vault tokens to allowed recipient %s", (index) => {
    const f = withPolicy();
    assertSuccess(send(f.svm, [createMintToInstruction(f.outputMint, f.outputVault, f.owner.publicKey, FUNDING)], [f.owner]));
    const policyBefore = accountData(f.svm, policyPda(f.vault)[0]);
    const vaultBefore = accountData(f.svm, f.vault);
    for (const [mint, source] of [[f.inputMint, f.inputVault], [f.outputMint, f.outputVault]]) {
      const destination = recipientAccount(f, f.recipients[index], mint);
      assertSuccess(send(f.svm, [withdrawTo(f, 123n, { source, destination })], [f.owner]));
      expect(tokenAccount(f.svm, destination).amount).toBe(123n);
      expect(tokenAccount(f.svm, source).amount).toBe(FUNDING - 123n);
    }
    expect(accountData(f.svm, policyPda(f.vault)[0])).toEqual(policyBefore);
    expect(accountData(f.svm, f.vault)).toEqual(vaultBefore);
  });

  it("always allows the owner", () => {
    const f = withPolicy();
    assertSuccess(send(f.svm, [withdrawTo(f, FUNDING)], [f.owner]));
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(FUNDING);
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(0n);
  });

  it.each(["revoked", "expired", "both"])("allows withdrawals when %s", (kind) => {
    const f = withPolicy();
    const destination = recipientAccount(f, f.recipients[0]);
    if (kind !== "expired") assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    if (kind !== "revoked") {
      const clock = f.svm.getClock();
      clock.unixTimestamp = f.policy.expiryUnix;
      f.svm.setClock(clock);
    }
    assertSuccess(send(f.svm, [withdrawTo(f, 2n, { destination })], [f.owner]));
    assertSuccess(send(f.svm, [withdrawTo(f, 1n)], [f.owner]));
    expect(tokenAccount(f.svm, destination).amount).toBe(2n);
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(1n);
  });

  it.each(["recipient", "mint", "source", "authority", "non-owner", "zero"])("rejects invalid %s without moving funds", (kind) => {
    const f = withPolicy();
    const destination = recipientAccount(f, kind === "recipient" ? Keypair.generate().publicKey : f.recipients[0], kind === "mint" ? f.outputMint : f.inputMint);
    const overrides = { destination,
      ...(kind === "source" && { source: f.ownerInput }),
      ...(kind === "authority" && { vault_authority: f.owner.publicKey }),
      ...(kind === "non-owner" && { owner: f.agent.publicKey }),
    };
    const before = snapshotVault(f);
    const result = send(f.svm, [withdrawTo(f, kind === "zero" ? 0n : 1n, overrides)], [kind === "non-owner" ? f.agent : f.owner]);
    if (kind === "authority") expect(result).toBeInstanceOf(FailedTransactionMetadata);
    else assertProgramError(result, kind === "non-owner" ? "Unauthorized" : kind === "zero" ? "InvalidAmount" : "AccountMismatch");
    expect(snapshotVault(f)).toEqual(before);
    expect(tokenAccount(f.svm, destination).amount).toBe(0n);
  });

  it("requires a policy even for withdraw_to to the owner", () => {
    const f = freshVault();
    expect(send(f.svm, [withdrawTo(f)], [f.owner])).toBeInstanceOf(FailedTransactionMetadata);
    assertSuccess(send(f.svm, [withdrawInstruction(f, 1n)], [f.owner]));
  });

  it("rejects another vault's valid policy", () => {
    const f = withPolicy();
    const id = Buffer.alloc(8); id.writeBigUInt64LE(1n);
    const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), f.owner.publicKey.toBuffer(), id], AEGIS_ID);
    const [authority, authorityBump] = PublicKey.findProgramAddressSync([Buffer.from("authority"), vault.toBuffer()], AEGIS_ID);
    const other = { ...f, vault, bump, authority, authorityBump, policy: { ...f.policy, vaultId: 1n },
      inputVault: getAssociatedTokenAddressSync(f.inputMint, authority, true), outputVault: getAssociatedTokenAddressSync(f.outputMint, authority, true) };
    assertSuccess(send(f.svm, [createVaultInstruction(other), setAddresses(other, f.recipients)], [f.owner]));
    const before = snapshotVault(f);
    expect(send(f.svm, [withdrawTo(f, 1n, { policy: policyPda(other.vault)[0] })], [f.owner])).toBeInstanceOf(FailedTransactionMetadata);
    expect(snapshotVault(f)).toEqual(before);
  });

  it.each(["vault", "bump"])("checks the stored policy %s", async (field) => {
    const f = withPolicy();
    const [policy, bump] = policyPda(f.vault);
    const account = f.svm.getAccount(address(policy.toBase58()));
    if (!account.exists) throw new Error("Missing policy");
    f.svm.setAccount({ ...account, data: await coder.encode("WithdrawPolicy", {
      vault: field === "vault" ? f.owner.publicKey : f.vault,
      allowed: f.recipients, count: 3, bump: field === "bump" ? (bump + 1) % 256 : bump,
    }) });
    const before = snapshotVault(f);
    const result = send(f.svm, [withdrawTo(f)], [f.owner]);
    if (field === "vault") assertProgramError(result, "AccountMismatch");
    else expect(result).toBeInstanceOf(FailedTransactionMetadata);
    expect(snapshotVault(f)).toEqual(before);
  });
});
