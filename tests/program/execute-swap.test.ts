import { BN } from "@coral-xyz/anchor";
import { address, lamports } from "@solana/kit";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  accountData, assertProgramError, assertSuccess, DEMO_DEX_ID, dexIdl,
  freshVault, FUNDING, instruction, readVault, revokeInstruction, send,
  snapshotVault, tokenAccount, withdrawInstruction,
} from "./helpers";
import {
  createPoolFixture, initializePoolInstruction, OUTPUT_LIQUIDITY, type PoolFixture,
  snapshotPool,
} from "./dex-helpers";

function freshSwapVault(liquidity = OUTPUT_LIQUIDITY) {
  const f = createPoolFixture(freshVault());
  assertSuccess(send(f.svm, [initializePoolInstruction(f)], [f.owner]));
  assertSuccess(send(f.svm, [
    createMintToInstruction(f.outputMint, f.outputReserve, f.owner.publicKey, liquidity),
  ], [f.owner]));
  return f;
}

function executeSwapInstruction(f: PoolFixture, amount: bigint, overrides: Record<string, PublicKey> = {}) {
  return instruction("execute_swap", { amount_in_raw: new BN(amount.toString()) }, {
    agent: f.agent.publicKey, vault: f.vault, vault_authority: f.authority,
    input_vault: f.inputVault, output_vault: f.outputVault,
    pool: f.pool, pool_authority: f.poolAuthority,
    input_reserve: f.inputReserve, output_reserve: f.outputReserve,
    demo_dex_program: DEMO_DEX_ID, token_program: TOKEN_PROGRAM_ID,
    ...overrides,
  });
}

function snapshot(f: PoolFixture) {
  return [...snapshotVault(f), ...snapshotPool(f)];
}

function assertPolicyError(result: ReturnType<typeof send>, name: string) {
  assertProgramError(result, name);
  // Rejections in steps 1–4 must happen before the exchange can move tokens.
  expect((result as FailedTransactionMetadata).meta().logs().join("\n"))
    .not.toContain(`Program ${DEMO_DEX_ID.toBase58()} invoke`);
}

describe("vault execute_swap", () => {
  it("swaps 20 through the PDA-signed CPI and records spent only after the real balance changes", () => {
    const f = freshSwapVault();
    const vaultBefore = readVault(f);
    const poolBefore = accountData(f.svm, f.pool);
    const result = send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]);
    assertSuccess(result);
    expect(result.logs().join("\n")).toContain(`Program ${DEMO_DEX_ID.toBase58()} invoke [2]`);
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING - 20_000_000n);
    expect(tokenAccount(f.svm, f.outputVault).amount).toBe(200_000_000n);
    expect(tokenAccount(f.svm, f.inputReserve).amount).toBe(20_000_000n);
    expect(tokenAccount(f.svm, f.outputReserve).amount).toBe(OUTPUT_LIQUIDITY - 200_000_000n);
    expect(readVault(f)).toEqual({ ...vaultBefore, spent_raw: 20_000_000n });
    expect(accountData(f.svm, f.pool)).toEqual(poolBefore);
  });

  it("permits a swap of 50 at the exact per-trade cap", () => {
    const f = freshSwapVault();
    const vaultBefore = readVault(f);
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 50_000_000n)], [f.agent]));
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING - 50_000_000n);
    expect(tokenAccount(f.svm, f.outputVault).amount).toBe(500_000_000n);
    expect(tokenAccount(f.svm, f.inputReserve).amount).toBe(50_000_000n);
    expect(tokenAccount(f.svm, f.outputReserve).amount).toBe(OUTPUT_LIQUIDITY - 500_000_000n);
    expect(readVault(f)).toEqual({ ...vaultBefore, spent_raw: 50_000_000n });
  });

  it("rejects 60 with CapExceeded and leaves balances and spent unchanged", () => {
    const f = freshSwapVault();
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 60_000_000n)], [f.agent]), "CapExceeded");
    expect(snapshot(f)).toEqual(before);
  });

  it("permits five swaps of 20, then rejects a sixth with BudgetExceeded", () => {
    // Fund enough output for all six trades to isolate the budget restriction.
    const liquidity = 1_200_000_000n;
    const f = freshSwapVault(liquidity);
    const vaultBefore = readVault(f);
    for (let count = 1n; count <= 5n; count++) {
      assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
      const spent = count * 20_000_000n;
      expect(readVault(f)).toEqual({ ...vaultBefore, spent_raw: spent });
      expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING - spent);
      expect(tokenAccount(f.svm, f.outputVault).amount).toBe(count * 200_000_000n);
      expect(tokenAccount(f.svm, f.inputReserve).amount).toBe(spent);
      expect(tokenAccount(f.svm, f.outputReserve).amount).toBe(liquidity - count * 200_000_000n);
    }
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]), "BudgetExceeded");
    expect(snapshot(f)).toEqual(before);
  });

  it("rejects output redirected to an attacker's token account with AccountMismatch", () => {
    const f = freshSwapVault();
    const attacker = Keypair.generate().publicKey;
    const destination = getAssociatedTokenAddressSync(f.outputMint, attacker);
    assertSuccess(send(f.svm, [
      createAssociatedTokenAccountInstruction(f.owner.publicKey, destination, attacker, f.outputMint),
    ], [f.owner]));
    const before = snapshot(f);
    const attackerBefore = accountData(f.svm, destination);
    assertPolicyError(send(f.svm, [
      executeSwapInstruction(f, 20_000_000n, { output_vault: destination }),
    ], [f.agent]), "AccountMismatch");
    expect(snapshot(f)).toEqual(before);
    expect(accountData(f.svm, destination)).toEqual(attackerBefore);
  });

  it("rejects a swap signed by the owner instead of the agent with Unauthorized", () => {
    const f = freshSwapVault();
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [
      executeSwapInstruction(f, 20_000_000n, { agent: f.owner.publicKey }),
    ], [f.owner]), "Unauthorized");
    expect(snapshot(f)).toEqual(before);
  });

  it("rejects an agent withdrawal with Unauthorized after a successful swap", () => {
    const f = freshSwapVault();
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [
      withdrawInstruction(f, 20_000_000n, { owner: f.agent.publicKey }),
    ], [f.agent]), "Unauthorized");
    expect(snapshot(f)).toEqual(before);
  });

  it("rejects an otherwise valid swap after revocation with Revoked", () => {
    const f = freshSwapVault();
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    expect(readVault(f)).toMatchObject({ revoked: true, spent_raw: 20_000_000n });
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]), "Revoked");
    expect(snapshot(f)).toEqual(before);
  });

  it.each([0n, 1n])("rejects an otherwise valid swap at expiry + %s seconds with Expired", (secondsAfterExpiry) => {
    const f = freshSwapVault();
    const clock = f.svm.getClock();
    clock.unixTimestamp = f.policy.expiryUnix - 1n;
    f.svm.setClock(clock);
    // Trading still works immediately before the chain-time boundary.
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    expect(readVault(f).spent_raw).toBe(20_000_000n);
    clock.unixTimestamp = f.policy.expiryUnix + secondsAfterExpiry;
    f.svm.setClock(clock);
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]), "Expired");
    expect(snapshot(f)).toEqual(before);
  });

  it("lets the owner withdraw remaining input and swap proceeds after revocation", () => {
    const f = freshSwapVault();
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    const revokedState = readVault(f);
    expect(revokedState).toMatchObject({ revoked: true, spent_raw: 20_000_000n });
    assertSuccess(send(f.svm, [
      withdrawInstruction(f, FUNDING - 20_000_000n),
      withdrawInstruction(f, 200_000_000n, { source: f.outputVault, destination: f.ownerOutput }),
    ], [f.owner]));
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(0n);
    expect(tokenAccount(f.svm, f.outputVault).amount).toBe(0n);
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(FUNDING - 20_000_000n);
    expect(tokenAccount(f.svm, f.ownerOutput).amount).toBe(200_000_000n);
    expect(tokenAccount(f.svm, f.inputReserve).amount).toBe(20_000_000n);
    expect(tokenAccount(f.svm, f.outputReserve).amount).toBe(OUTPUT_LIQUIDITY - 200_000_000n);
    expect(readVault(f)).toEqual(revokedState);
  });

  it.each([
    "input_vault", "pool", "input_reserve", "output_reserve",
    "vault_authority", "pool_authority", "demo_dex_program", "token_program",
  ])("rejects a substituted %s before CPI with AccountMismatch", (account) => {
    const f = freshSwapVault();
    const replacements: Record<string, PublicKey> = {
      input_vault: f.ownerInput,
      pool: f.vault,
      input_reserve: f.ownerInput,
      output_reserve: f.ownerOutput,
      vault_authority: f.owner.publicKey,
      pool_authority: f.owner.publicKey,
      demo_dex_program: SystemProgram.programId,
      token_program: SystemProgram.programId,
    };
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [
      executeSwapInstruction(f, 20_000_000n, { [account]: replacements[account] }),
    ], [f.agent]), "AccountMismatch");
    expect(snapshot(f)).toEqual(before);
  });

  it.each([
    { error: "Unauthorized", wrongSigner: true, revoked: true, expired: true, amount: 0n },
    { error: "Revoked", wrongSigner: false, revoked: true, expired: true, amount: 0n },
    { error: "Expired", wrongSigner: false, revoked: false, expired: true, amount: 0n },
    { error: "InvalidAmount", wrongSigner: false, revoked: false, expired: false, amount: 0n },
    { error: "CapExceeded", wrongSigner: false, revoked: false, expired: false, amount: 120_000_000n },
    { error: "BudgetExceeded", wrongSigner: false, revoked: false, expired: false, amount: 40_000_000n },
  ])("checks $error before later policy failures and invalid program accounts", (test) => {
    const f = freshSwapVault();
    if (test.error === "BudgetExceeded") {
      for (let i = 0; i < 2; i++) {
        assertSuccess(send(f.svm, [executeSwapInstruction(f, 40_000_000n)], [f.agent]));
      }
    }
    if (test.revoked) assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    if (test.expired) {
      const clock = f.svm.getClock();
      clock.unixTimestamp = f.policy.expiryUnix;
      f.svm.setClock(clock);
    }
    const signer = test.wrongSigner ? f.owner : f.agent;
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, test.amount, {
      agent: signer.publicKey,
      demo_dex_program: SystemProgram.programId,
      token_program: SystemProgram.programId,
    })], [signer]), test.error);
    expect(snapshot(f)).toEqual(before);
  });

  it("propagates a failed exchange CPI without spending budget or moving tokens", () => {
    const f = freshSwapVault(199_999_999n);
    const before = snapshot(f);
    assertProgramError(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]), "InsufficientReserve", dexIdl);
    expect(snapshot(f)).toEqual(before);
  });
});

describe("vault rotate_agent", () => {
  function rotateInstruction(f: PoolFixture, newAgent: PublicKey, owner = f.owner.publicKey) {
    return instruction("rotate_agent", { new_agent: newAgent }, { owner, vault: f.vault });
  }

  function fundedReplacement(f: PoolFixture) {
    const replacement = Keypair.generate();
    assertSuccess(f.svm.airdrop(address(replacement.publicKey.toBase58()), lamports(10_000_000_000n)));
    return replacement;
  }

  it.each([false, true])("lets the owner rotate with revoked=%s, preserving policy and enabling only the new agent", (revoked) => {
    const f = freshSwapVault();
    const replacement = fundedReplacement(f);
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    if (revoked) {
      assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
      const before = snapshot(f);
      assertPolicyError(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]), "Revoked");
      expect(snapshot(f)).toEqual(before);
    }
    const stateBefore = readVault(f);
    const accountsBefore = snapshot(f);
    assertSuccess(send(f.svm, [rotateInstruction(f, replacement.publicKey)], [f.owner]));
    expect(readVault(f)).toEqual({ ...stateBefore, agent: replacement.publicKey, revoked: false });
    expect(snapshot(f).slice(1)).toEqual(accountsBefore.slice(1));

    const rotated = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]), "Unauthorized");
    expect(snapshot(f)).toEqual(rotated);
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n, { agent: replacement.publicKey })], [replacement]));
    expect(readVault(f)).toEqual({ ...stateBefore, agent: replacement.publicKey, revoked: false, spent_raw: 40_000_000n });
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING - 40_000_000n);
    expect(tokenAccount(f.svm, f.outputVault).amount).toBe(400_000_000n);
  });

  it("enforces the same cumulative budget across the old and new agents", () => {
    const f = freshSwapVault();
    const replacement = fundedReplacement(f);
    for (let i = 0; i < 2; i++) {
      assertSuccess(send(f.svm, [executeSwapInstruction(f, 40_000_000n)], [f.agent]));
    }
    const stateBefore = readVault(f);
    expect(stateBefore.spent_raw).toBe(80_000_000n);
    const accountsBefore = snapshot(f);
    assertSuccess(send(f.svm, [rotateInstruction(f, replacement.publicKey)], [f.owner]));
    expect(readVault(f)).toEqual({ ...stateBefore, agent: replacement.publicKey, revoked: false });
    expect(snapshot(f).slice(1)).toEqual(accountsBefore.slice(1));

    const beforeOverspend = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 40_000_000n, { agent: replacement.publicKey })], [replacement]), "BudgetExceeded");
    expect(snapshot(f)).toEqual(beforeOverspend);
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n, { agent: replacement.publicKey })], [replacement]));
    expect(readVault(f)).toEqual({ ...stateBefore, agent: replacement.publicKey, revoked: false, spent_raw: 100_000_000n });
    expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING - 100_000_000n);
    expect(tokenAccount(f.svm, f.outputVault).amount).toBe(1_000_000_000n);
    const exhausted = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 20_000_000n, { agent: replacement.publicKey })], [replacement]), "BudgetExceeded");
    expect(snapshot(f)).toEqual(exhausted);
  });

  it.each([false, true])("rejects rotation by the agent with Unauthorized when revoked=%s", (revoked) => {
    const f = freshSwapVault();
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    if (revoked) assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [rotateInstruction(f, Keypair.generate().publicKey, f.agent.publicKey)], [f.agent]), "Unauthorized");
    expect(snapshot(f)).toEqual(before);
  });

  it.each(["default key", "owner", "current agent"])("rejects the %s as replacement without clearing revocation or changing state", (invalidAgent) => {
    const f = freshSwapVault();
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    assertSuccess(send(f.svm, [revokeInstruction(f)], [f.owner]));
    const newAgent = invalidAgent === "default key" ? PublicKey.default
      : invalidAgent === "owner" ? f.owner.publicKey : f.agent.publicKey;
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [rotateInstruction(f, newAgent)], [f.owner]), "InvalidAmount");
    expect(snapshot(f)).toEqual(before);
  });

  it("does not extend an expired vault's trading permission when rotating", () => {
    const f = freshSwapVault();
    const replacement = fundedReplacement(f);
    assertSuccess(send(f.svm, [executeSwapInstruction(f, 20_000_000n)], [f.agent]));
    const clock = f.svm.getClock();
    clock.unixTimestamp = f.policy.expiryUnix;
    f.svm.setClock(clock);
    const stateBefore = readVault(f);
    const accountsBefore = snapshot(f);
    assertSuccess(send(f.svm, [rotateInstruction(f, replacement.publicKey)], [f.owner]));
    expect(readVault(f)).toEqual({ ...stateBefore, agent: replacement.publicKey, revoked: false });
    expect(snapshot(f).slice(1)).toEqual(accountsBefore.slice(1));
    const rotated = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 20_000_000n, { agent: replacement.publicKey })], [replacement]), "Expired");
    expect(snapshot(f)).toEqual(rotated);
  });
});
