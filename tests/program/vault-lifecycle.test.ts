import { address } from "@solana/kit";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  accountData, AEGIS_ID, assertProgramError, assertSuccess, createFixture,
  createVaultInstruction, freshVault, FUNDING, NOW, readVault, revokeInstruction,
  send, snapshotVault, tokenAccount, withdrawInstruction,
} from "./helpers";

describe("vault lifecycle", () => {
  it("creates the specified policy, PDA state, and ATAs and funds 1,000 testUSDC", () => {
    const f = freshVault();
    expect(readVault(f)).toEqual({
      owner: f.owner.publicKey, agent: f.agent.publicKey, vault_id: 0n,
      input_mint: f.inputMint, output_mint: f.outputMint,
      input_vault: f.inputVault, output_vault: f.outputVault,
      max_trade_raw: 50_000_000n, budget_raw: 100_000_000n,
      expiry_unix: NOW + 3_600n, spent_raw: 0n, revoked: false,
      bump: f.bump, authority_bump: f.authorityBump, pool_bump: f.poolBump,
    });
    expect(f.svm.getAccount(address(f.vault.toBase58()))).toMatchObject({
      exists: true, programAddress: AEGIS_ID.toBase58(),
    });
    for (const [key, mint, amount] of [[f.inputVault, f.inputMint, FUNDING], [f.outputVault, f.outputMint, 0n]] as const) {
      expect(tokenAccount(f.svm, key)).toMatchObject({ owner: f.authority, mint, amount, delegateOption: 0 });
      expect(f.svm.getAccount(address(key.toBase58()))).toMatchObject({ programAddress: TOKEN_PROGRAM_ID.toBase58() });
    }
    expect(MintLayout.decode(accountData(f.svm, f.inputMint)).decimals).toBe(6);
    expect(MintLayout.decode(accountData(f.svm, f.outputMint)).decimals).toBe(9);
  });

  it.each([
    ["zero cap", { maxTradeRaw: 0n }],
    ["zero budget", { budgetRaw: 0n }],
    ["cap over budget", { maxTradeRaw: 100_000_001n }],
    ["expiry equal to chain time", { expiryUnix: NOW }],
    ["expiry in the past", { expiryUnix: NOW - 1n }],
    ["equal input and output mints", { sameMint: true }],
  ])("rejects %s with InvalidAmount and rolls back account creation", (_, policy) => {
    const f = createFixture(policy);
    const mintsBefore = [accountData(f.svm, f.inputMint), accountData(f.svm, f.outputMint)];
    assertProgramError(send(f.svm, [createVaultInstruction(f)], [f.owner]), "InvalidAmount");
    for (const key of [f.vault, f.inputVault, f.outputVault]) {
      expect(f.svm.getAccount(address(key.toBase58())).exists).toBe(false);
    }
    expect([accountData(f.svm, f.inputMint), accountData(f.svm, f.outputMint)]).toEqual(mintsBefore);
  });

  it.each(["default key", "owner"])("rejects the %s as agent with InvalidAmount and creates no accounts", (invalidAgent) => {
    const f = createFixture();
    const agent = invalidAgent === "default key" ? PublicKey.default : f.owner.publicKey;
    const accounts = [f.vault, f.inputVault, f.outputVault];
    const mintsBefore = [accountData(f.svm, f.inputMint), accountData(f.svm, f.outputMint)];
    for (const key of accounts) {
      expect(f.svm.getAccount(address(key.toBase58())).exists).toBe(false);
    }
    assertProgramError(send(f.svm, [createVaultInstruction(f, agent)], [f.owner]), "InvalidAmount");
    for (const key of accounts) {
      expect(f.svm.getAccount(address(key.toBase58())).exists).toBe(false);
    }
    expect([accountData(f.svm, f.inputMint), accountData(f.svm, f.outputMint)]).toEqual(mintsBefore);
  });

  it("preserves full u64 policy values and permits cap equal to budget", () => {
    const maxU64 = (1n << 64n) - 1n;
    const f = createFixture({ vaultId: maxU64, maxTradeRaw: maxU64, budgetRaw: maxU64 });
    assertSuccess(send(f.svm, [createVaultInstruction(f)], [f.owner]));
    expect(readVault(f)).toMatchObject({ vault_id: maxU64, max_trade_raw: maxU64, budget_raw: maxU64 });
  });

  it.each(["input", "output"] as const)("lets the owner withdraw %s tokens with the vault PDA signature", (side) => {
    const f = freshVault();
    const source = side === "input" ? f.inputVault : f.outputVault;
    const destination = side === "input" ? f.ownerInput : f.ownerOutput;
    const amount = side === "input" ? 250_000_000n : 200_000_000n;
    if (side === "output") {
      assertSuccess(send(f.svm, [createMintToInstruction(f.outputMint, source, f.owner.publicKey, amount)], [f.owner]));
    }
    const sourceBefore = tokenAccount(f.svm, source).amount;
    const destinationBefore = tokenAccount(f.svm, destination).amount;
    const stateBefore = readVault(f);
    assertSuccess(send(f.svm, [withdrawInstruction(f, amount, { source, destination })], [f.owner]));
    expect(tokenAccount(f.svm, source).amount).toBe(sourceBefore - amount);
    expect(tokenAccount(f.svm, destination).amount).toBe(destinationBefore + amount);
    expect(readVault(f)).toEqual(stateBefore);
  });

  it("rejects an agent withdrawal with Unauthorized and preserves both balances and state", () => {
    const f = freshVault();
    const before = snapshotVault(f);
    const destinationBefore = accountData(f.svm, f.ownerInput);
    assertProgramError(send(f.svm, [withdrawInstruction(f, 20_000_000n, { owner: f.agent.publicKey })], [f.agent]), "Unauthorized");
    expect(snapshotVault(f)).toEqual(before);
    expect(accountData(f.svm, f.ownerInput)).toEqual(destinationBefore);
  });

  it("rejects revocation by the agent with Unauthorized", () => {
    const f = freshVault();
    const before = snapshotVault(f);
    assertProgramError(send(f.svm, [revokeInstruction(f, f.agent.publicKey)], [f.agent]), "Unauthorized");
    expect(snapshotVault(f)).toEqual(before);
  });

  it("revokes permanently, remains revoked on repeated calls, and cannot be reinitialized", () => {
    const f = freshVault();
    const stateBefore = readVault(f);
    const balancesBefore = [tokenAccount(f.svm, f.inputVault).amount, tokenAccount(f.svm, f.outputVault).amount];
    assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    expect(readVault(f)).toEqual({ ...stateBefore, revoked: true });
    const revokedState = snapshotVault(f);
    assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    expect(snapshotVault(f)).toEqual(revokedState);
    expect(send(f.svm, [createVaultInstruction(f)], [f.owner])).toBeInstanceOf(FailedTransactionMetadata);
    expect(snapshotVault(f)).toEqual(revokedState);
    expect([tokenAccount(f.svm, f.inputVault).amount, tokenAccount(f.svm, f.outputVault).amount]).toEqual(balancesBefore);
  });

  it.each(["revoked", "expired", "revoked and expired"])("lets the owner withdraw everything when %s", (condition) => {
    const f = freshVault();
    assertSuccess(send(f.svm, [createMintToInstruction(f.outputMint, f.outputVault, f.owner.publicKey, 200_000_000n)], [f.owner]));
    if (condition.includes("revoked")) assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    if (condition.includes("expired")) {
      const clock = f.svm.getClock();
      clock.unixTimestamp = f.policy.expiryUnix;
      f.svm.setClock(clock);
    }
    const stateBefore = readVault(f);
    assertSuccess(send(f.svm, [withdrawInstruction(f, FUNDING)], [f.owner]));
    assertSuccess(send(f.svm, [withdrawInstruction(f, 200_000_000n, { source: f.outputVault, destination: f.ownerOutput })], [f.owner]));
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(0n);
    expect(tokenAccount(f.svm, f.outputVault).amount).toBe(0n);
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(FUNDING);
    expect(tokenAccount(f.svm, f.ownerOutput).amount).toBe(200_000_000n);
    expect(readVault(f)).toEqual(stateBefore);
  });

  it.each(["wrong destination owner", "wrong destination mint", "unrelated source"])("rejects %s with AccountMismatch", (attack) => {
    const f = freshVault();
    const agentToken = getAssociatedTokenAddressSync(f.inputMint, f.agent.publicKey);
    assertSuccess(send(f.svm, [createAssociatedTokenAccountInstruction(f.owner.publicKey, agentToken, f.agent.publicKey, f.inputMint)], [f.owner]));
    const overrides = attack === "wrong destination owner" ? { destination: agentToken }
      : attack === "wrong destination mint" ? { destination: f.ownerOutput }
      : { source: agentToken };
    const before = snapshotVault(f);
    const externalBefore = [f.ownerInput, f.ownerOutput, agentToken].map((key) => accountData(f.svm, key));
    assertProgramError(send(f.svm, [withdrawInstruction(f, 1n, overrides)], [f.owner]), "AccountMismatch");
    expect(snapshotVault(f)).toEqual(before);
    expect([f.ownerInput, f.ownerOutput, agentToken].map((key) => accountData(f.svm, key))).toEqual(externalBefore);
  });

  it("rejects a substituted authority PDA without moving tokens", () => {
    const f = freshVault();
    const before = snapshotVault(f);
    const destinationBefore = accountData(f.svm, f.ownerInput);
    expect(send(f.svm, [withdrawInstruction(f, 1n, { vault_authority: f.agent.publicKey })], [f.owner])).toBeInstanceOf(FailedTransactionMetadata);
    expect(snapshotVault(f)).toEqual(before);
    expect(accountData(f.svm, f.ownerInput)).toEqual(destinationBefore);
  });

  it.each([0n, FUNDING + 1n])("rejects invalid withdrawal amount %s atomically", (amount) => {
    const f = freshVault();
    const before = snapshotVault(f);
    const destinationBefore = accountData(f.svm, f.ownerInput);
    const result = send(f.svm, [withdrawInstruction(f, amount)], [f.owner]);
    if (amount === 0n) assertProgramError(result, "InvalidAmount");
    else expect(result).toBeInstanceOf(FailedTransactionMetadata);
    expect(snapshotVault(f)).toEqual(before);
    expect(accountData(f.svm, f.ownerInput)).toEqual(destinationBefore);
  });
});
