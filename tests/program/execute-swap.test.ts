import { BN } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, type PublicKey, SystemProgram } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  accountData, assertProgramError, assertSuccess, DEMO_DEX_ID, dexIdl,
  freshVault, FUNDING, instruction, readVault, revokeInstruction, send,
  snapshotVault, tokenAccount,
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

  it("rejects 60 with CapExceeded and leaves balances and spent unchanged", () => {
    const f = freshSwapVault();
    const before = snapshot(f);
    assertPolicyError(send(f.svm, [executeSwapInstruction(f, 60_000_000n)], [f.agent]), "CapExceeded");
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
