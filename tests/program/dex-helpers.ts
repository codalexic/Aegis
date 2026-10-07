import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  accountData, assertSuccess, createFixture, DEMO_DEX_ID, dexIdl,
  FUNDING, instruction, send,
} from "./helpers";

export const OUTPUT_LIQUIDITY = 1_000_000_000n;
const poolCoder = new BorshAccountsCoder(dexIdl);

export function createPoolFixture(f = createFixture()) {
  const [pool, poolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), f.inputMint.toBuffer(), f.outputMint.toBuffer()], DEMO_DEX_ID,
  );
  const [poolAuthority, poolAuthorityBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), pool.toBuffer()], DEMO_DEX_ID,
  );
  return {
    ...f, pool, poolBump, poolAuthority, poolAuthorityBump,
    inputReserve: getAssociatedTokenAddressSync(f.inputMint, poolAuthority, true),
    outputReserve: getAssociatedTokenAddressSync(f.outputMint, poolAuthority, true),
  };
}

export type PoolFixture = ReturnType<typeof createPoolFixture>;

export function initializePoolInstruction(f: PoolFixture) {
  return instruction("initialize_pool", {}, {
    payer: f.owner.publicKey, input_mint: f.inputMint, output_mint: f.outputMint,
    pool: f.pool, pool_authority: f.poolAuthority,
    input_reserve: f.inputReserve, output_reserve: f.outputReserve,
    token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  }, dexIdl);
}

export function freshPool(inputBalance = FUNDING, outputReserve = OUTPUT_LIQUIDITY) {
  const f = createPoolFixture();
  assertSuccess(send(f.svm, [initializePoolInstruction(f)], [f.owner]));
  assertSuccess(send(f.svm, [
    createAssociatedTokenAccountInstruction(f.owner.publicKey, f.ownerInput, f.owner.publicKey, f.inputMint),
    createAssociatedTokenAccountInstruction(f.owner.publicKey, f.ownerOutput, f.owner.publicKey, f.outputMint),
    createMintToInstruction(f.inputMint, f.ownerInput, f.owner.publicKey, inputBalance),
    createMintToInstruction(f.outputMint, f.ownerOutput, f.owner.publicKey, outputReserve),
    createTransferInstruction(f.ownerOutput, f.outputReserve, f.owner.publicKey, outputReserve),
  ], [f.owner]));
  return f;
}

export function swapInstruction(f: PoolFixture, amount: bigint, overrides: Record<string, PublicKey> = {}) {
  return instruction("swap", { amount_in: new BN(amount.toString()) }, {
    user_authority: f.owner.publicKey, pool: f.pool, pool_authority: f.poolAuthority,
    user_input: f.ownerInput, user_output: f.ownerOutput,
    input_reserve: f.inputReserve, output_reserve: f.outputReserve,
    token_program: TOKEN_PROGRAM_ID,
    ...overrides,
  }, dexIdl);
}

type PoolState = {
  input_mint: PublicKey;
  output_mint: PublicKey;
  input_reserve: PublicKey;
  output_reserve: PublicKey;
  bump: number;
  authority_bump: number;
};

export function readPool(f: PoolFixture) {
  return poolCoder.decode<PoolState>("Pool", accountData(f.svm, f.pool));
}

export function snapshotPool(f: PoolFixture) {
  return [f.pool, f.inputReserve, f.outputReserve, f.ownerInput, f.ownerOutput]
    .map((key) => accountData(f.svm, key));
}
