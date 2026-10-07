import { address } from "@solana/kit";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { type PublicKey } from "@solana/web3.js";
import { FailedTransactionMetadata } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  accountData, assertProgramError, assertSuccess, createFixture, DEMO_DEX_ID,
  dexIdl, FUNDING, send, tokenAccount,
} from "./helpers";
import {
  createPoolFixture, freshPool, initializePoolInstruction, OUTPUT_LIQUIDITY,
  readPool, snapshotPool, swapInstruction,
} from "./dex-helpers";

describe("demo exchange", () => {
  it("initializes the pool PDA, authority, and two empty reserve ATAs", () => {
    const f = createPoolFixture();
    assertSuccess(send(f.svm, [initializePoolInstruction(f)], [f.owner]));
    expect(readPool(f)).toEqual({
      input_mint: f.inputMint, output_mint: f.outputMint,
      input_reserve: f.inputReserve, output_reserve: f.outputReserve,
      bump: f.poolBump, authority_bump: f.poolAuthorityBump,
    });
    expect(f.svm.getAccount(address(f.pool.toBase58()))).toMatchObject({
      exists: true, programAddress: DEMO_DEX_ID.toBase58(),
    });
    for (const [key, mint] of [[f.inputReserve, f.inputMint], [f.outputReserve, f.outputMint]]) {
      expect(tokenAccount(f.svm, key)).toMatchObject({ mint, owner: f.poolAuthority, amount: 0n, delegateOption: 0 });
      expect(f.svm.getAccount(address(key.toBase58()))).toMatchObject({ programAddress: TOKEN_PROGRAM_ID.toBase58() });
    }
  });

  it("rejects equal mints before reserve creation and rolls back the pool", () => {
    const f = createPoolFixture(createFixture({ sameMint: true }));
    const mintBefore = accountData(f.svm, f.inputMint);
    assertProgramError(send(f.svm, [initializePoolInstruction(f)], [f.owner]), "AccountMismatch", dexIdl);
    for (const key of [f.pool, f.inputReserve, f.outputReserve]) {
      expect(f.svm.getAccount(address(key.toBase58())).exists).toBe(false);
    }
    expect(accountData(f.svm, f.inputMint)).toEqual(mintBefore);
  });

  it("does not allow an existing funded pool to be reinitialized", () => {
    const f = freshPool();
    const before = snapshotPool(f);
    expect(send(f.svm, [initializePoolInstruction(f)], [f.owner])).toBeInstanceOf(FailedTransactionMetadata);
    expect(snapshotPool(f)).toEqual(before);
  });

  it("swaps 20 testUSDC: exactly 20000000 raw in and 200000000 raw out", () => {
    const f = freshPool();
    const poolBefore = accountData(f.svm, f.pool);
    assertSuccess(send(f.svm, [swapInstruction(f, 20_000_000n)], [f.owner]));
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(FUNDING - 20_000_000n);
    expect(tokenAccount(f.svm, f.inputReserve).amount).toBe(20_000_000n);
    expect(tokenAccount(f.svm, f.ownerOutput).amount).toBe(200_000_000n);
    expect(tokenAccount(f.svm, f.outputReserve).amount).toBe(OUTPUT_LIQUIDITY - 200_000_000n);
    expect(accountData(f.svm, f.pool)).toEqual(poolBefore);
  });

  it("rejects a swap exceeding the output reserve with InsufficientReserve and no balance changes", () => {
    const f = freshPool();
    const before = snapshotPool(f);
    assertProgramError(send(f.svm, [swapInstruction(f, OUTPUT_LIQUIDITY / 10n + 1n)], [f.owner]), "InsufficientReserve", dexIdl);
    expect(snapshotPool(f)).toEqual(before);
  });

  it("permits an exact reserve-sized swap, then rejects the next swap", () => {
    const f = freshPool();
    assertSuccess(send(f.svm, [swapInstruction(f, OUTPUT_LIQUIDITY / 10n)], [f.owner]));
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(FUNDING - OUTPUT_LIQUIDITY / 10n);
    expect(tokenAccount(f.svm, f.inputReserve).amount).toBe(OUTPUT_LIQUIDITY / 10n);
    expect(tokenAccount(f.svm, f.ownerOutput).amount).toBe(OUTPUT_LIQUIDITY);
    expect(tokenAccount(f.svm, f.outputReserve).amount).toBe(0n);
    const before = snapshotPool(f);
    assertProgramError(send(f.svm, [swapInstruction(f, 1n)], [f.owner]), "InsufficientReserve", dexIdl);
    expect(snapshotPool(f)).toEqual(before);
  });

  it.each([0n, ((1n << 64n) - 1n) / 10n + 1n])("rejects zero or overflowing input %s with InvalidAmount", (amount) => {
    const f = freshPool();
    const before = snapshotPool(f);
    assertProgramError(send(f.svm, [swapInstruction(f, amount)], [f.owner]), "InvalidAmount", dexIdl);
    expect(snapshotPool(f)).toEqual(before);
  });

  it("preserves exact token amounts above JavaScript's safe integer range", () => {
    const amount = (1n << 53n) + 1n;
    const f = freshPool(amount, amount * 10n);
    assertSuccess(send(f.svm, [swapInstruction(f, amount)], [f.owner]));
    expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(0n);
    expect(tokenAccount(f.svm, f.inputReserve).amount).toBe(amount);
    expect(tokenAccount(f.svm, f.ownerOutput).amount).toBe(amount * 10n);
    expect(tokenAccount(f.svm, f.outputReserve).amount).toBe(0n);
  });

  it.each(["input mint", "output mint", "input reserve", "output reserve", "input owner"])("rejects substituted %s with AccountMismatch", (attack) => {
    const f = freshPool();
    const agentInput = getAssociatedTokenAddressSync(f.inputMint, f.agent.publicKey);
    const agentOutput = getAssociatedTokenAddressSync(f.outputMint, f.agent.publicKey);
    assertSuccess(send(f.svm, [
      createAssociatedTokenAccountInstruction(f.owner.publicKey, agentInput, f.agent.publicKey, f.inputMint),
      createAssociatedTokenAccountInstruction(f.owner.publicKey, agentOutput, f.agent.publicKey, f.outputMint),
    ], [f.owner]));
    const overrides: Record<string, Record<string, PublicKey>> = {
      "input mint": { user_input: agentOutput },
      "output mint": { user_output: agentInput },
      "input reserve": { input_reserve: agentInput },
      "output reserve": { output_reserve: agentOutput },
      "input owner": { user_input: agentInput },
    };
    const before = snapshotPool(f);
    const externalBefore = [agentInput, agentOutput].map((key) => accountData(f.svm, key));
    assertProgramError(send(f.svm, [swapInstruction(f, 20_000_000n, overrides[attack])], [f.owner]), "AccountMismatch", dexIdl);
    expect(snapshotPool(f)).toEqual(before);
    expect([agentInput, agentOutput].map((key) => accountData(f.svm, key))).toEqual(externalBefore);
  });

  it("rejects a substituted pool authority PDA without moving tokens", () => {
    const f = freshPool();
    const before = snapshotPool(f);
    const result = send(f.svm, [swapInstruction(f, 20_000_000n, { pool_authority: f.agent.publicKey })], [f.owner]);
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    expect((result as FailedTransactionMetadata).meta().logs().join("\n")).toContain("Error Code: ConstraintSeeds.");
    expect(snapshotPool(f)).toEqual(before);
  });

  it("does not pay out when the user has insufficient input tokens", () => {
    const f = freshPool(19_999_999n);
    const before = snapshotPool(f);
    const result = send(f.svm, [swapInstruction(f, 20_000_000n)], [f.owner]);
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    expect((result as FailedTransactionMetadata).meta().logs().join("\n")).toContain("Error: insufficient funds");
    expect(snapshotPool(f)).toEqual(before);
  });
});
