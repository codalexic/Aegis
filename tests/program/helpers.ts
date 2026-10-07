import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BN, BorshAccountsCoder, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type Signer } from "@solana/web3.js";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { expect } from "vitest";

const root = new URL("../../", import.meta.url);
export const aegisIdl: Idl = JSON.parse(readFileSync(new URL("target/idl/aegis.json", root), "utf8"));
export const dexIdl: Idl = JSON.parse(readFileSync(new URL("target/idl/demo_dex.json", root), "utf8"));
export const AEGIS_ID = new PublicKey(aegisIdl.address);
export const DEMO_DEX_ID = new PublicKey(dexIdl.address);
const accountCoder = new BorshAccountsCoder(aegisIdl);
const transactionDecoder = getTransactionDecoder();

export const NOW = 1_800_000_000n;
export const FUNDING = 1_000_000_000n;

export type Policy = {
  vaultId: bigint;
  maxTradeRaw: bigint;
  budgetRaw: bigint;
  expiryUnix: bigint;
};

export function instruction(name: string, args: Record<string, unknown>, accounts: Record<string, PublicKey>, idl: Idl = aegisIdl) {
  const definition = idl.instructions.find((item) => item.name === name);
  if (!definition) throw new Error(`Unknown instruction: ${name}`);
  return new TransactionInstruction({
    programId: new PublicKey(idl.address),
    keys: definition.accounts.map((account) => {
      if ("accounts" in account) throw new Error("Nested accounts are not used by Aegis");
      const pubkey = accounts[account.name];
      if (!pubkey) throw new Error(`Missing account: ${account.name}`);
      return { pubkey, isSigner: account.signer ?? false, isWritable: account.writable ?? false };
    }),
    data: new BorshInstructionCoder(idl).encode(name, args),
  });
}

export function send(svm: LiteSVM, instructions: TransactionInstruction[], signers: [Signer, ...Signer[]]) {
  const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: svm.latestBlockhash() });
  tx.add(...instructions);
  tx.sign(...signers);
  // LiteSVM 1.5 accepts Kit transactions; retain web3.js for the specified client API.
  const result = svm.sendTransaction(transactionDecoder.decode(tx.serialize()));
  svm.expireBlockhash();
  return result;
}

export function assertSuccess(result: TransactionMetadata | FailedTransactionMetadata | null): asserts result is TransactionMetadata {
  if (result === null) throw new Error("Transaction returned no metadata");
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`Transaction failed: ${result.err()}\n${result.meta().logs().join("\n")}`);
  }
}

export function assertProgramError(result: TransactionMetadata | FailedTransactionMetadata, name: string, idl: Idl = aegisIdl) {
  expect(result, "Expected the program to reject the transaction").toBeInstanceOf(FailedTransactionMetadata);
  const failure = result as FailedTransactionMetadata;
  const expected = idl.errors?.find((error) => error.name === name);
  expect(expected).toBeDefined();
  expect(failure.meta().logs().join("\n")).toContain(`Error Code: ${name}. Error Number: ${expected!.code}.`);
}

export function accountData(svm: LiteSVM, key: PublicKey) {
  const account = svm.getAccount(address(key.toBase58()));
  if (!account.exists) throw new Error(`Account not found: ${key.toBase58()}`);
  return Buffer.from(account.data);
}

export function tokenAccount(svm: LiteSVM, key: PublicKey) {
  return AccountLayout.decode(accountData(svm, key));
}

type RawVault = {
  owner: PublicKey;
  agent: PublicKey;
  vault_id: BN;
  input_mint: PublicKey;
  output_mint: PublicKey;
  input_vault: PublicKey;
  output_vault: PublicKey;
  max_trade_raw: BN;
  budget_raw: BN;
  expiry_unix: BN;
  spent_raw: BN;
  revoked: boolean;
  bump: number;
  authority_bump: number;
  pool_bump: number;
};

export function readVault(f: Fixture) {
  const state = accountCoder.decode<RawVault>("Vault", accountData(f.svm, f.vault));
  return {
    ...state,
    vault_id: BigInt(state.vault_id.toString()),
    max_trade_raw: BigInt(state.max_trade_raw.toString()),
    budget_raw: BigInt(state.budget_raw.toString()),
    expiry_unix: BigInt(state.expiry_unix.toString()),
    spent_raw: BigInt(state.spent_raw.toString()),
  };
}

// Capture all vault state (including spent_raw) and both complete token accounts.
export function snapshotVault(f: Fixture) {
  return [f.vault, f.inputVault, f.outputVault].map((key) => accountData(f.svm, key));
}

function seedMint(svm: LiteSVM, mint: PublicKey, authority: PublicKey, decimals: number) {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({
    mintAuthorityOption: 1,
    mintAuthority: authority,
    supply: 0n,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, data);
  // Only fixture mints are seeded; vaults and token accounts are created by transactions.
  svm.setAccount({
    address: address(mint.toBase58()),
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
    programAddress: address(TOKEN_PROGRAM_ID.toBase58()),
    space: BigInt(MINT_SIZE),
  });
}

export function createFixture(overrides: Partial<Policy> & { sameMint?: boolean } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(address(AEGIS_ID.toBase58()), fileURLToPath(new URL("target/deploy/aegis.so", root)));
  svm.addProgramFromFile(address(DEMO_DEX_ID.toBase58()), fileURLToPath(new URL("target/deploy/demo_dex.so", root)));
  const clock = svm.getClock();
  clock.unixTimestamp = NOW;
  svm.setClock(clock);
  // Ephemeral test keys stay in memory and are never logged or persisted.
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  for (const signer of [owner, agent]) {
    assertSuccess(svm.airdrop(address(signer.publicKey.toBase58()), lamports(10_000_000_000n)));
  }
  const inputMint = Keypair.generate().publicKey;
  const outputMint = overrides.sameMint ? inputMint : Keypair.generate().publicKey;
  seedMint(svm, inputMint, owner.publicKey, 6);
  if (!overrides.sameMint) seedMint(svm, outputMint, owner.publicKey, 9);
  const policy: Policy = {
    vaultId: overrides.vaultId ?? 0n,
    maxTradeRaw: overrides.maxTradeRaw ?? 50_000_000n,
    budgetRaw: overrides.budgetRaw ?? 100_000_000n,
    expiryUnix: overrides.expiryUnix ?? clock.unixTimestamp + 3_600n,
  };
  const vaultIdBytes = Buffer.alloc(8);
  vaultIdBytes.writeBigUInt64LE(policy.vaultId);
  const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer(), vaultIdBytes], AEGIS_ID);
  const [authority, authorityBump] = PublicKey.findProgramAddressSync([Buffer.from("authority"), vault.toBuffer()], AEGIS_ID);
  const [, poolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), inputMint.toBuffer(), outputMint.toBuffer()], DEMO_DEX_ID,
  );
  return {
    svm, owner, agent, inputMint, outputMint, policy, vault, bump, authority, authorityBump, poolBump,
    inputVault: getAssociatedTokenAddressSync(inputMint, authority, true),
    outputVault: getAssociatedTokenAddressSync(outputMint, authority, true),
    ownerInput: getAssociatedTokenAddressSync(inputMint, owner.publicKey),
    ownerOutput: getAssociatedTokenAddressSync(outputMint, owner.publicKey),
  };
}

export type Fixture = ReturnType<typeof createFixture>;

export function createVaultInstruction(f: Fixture, agent = f.agent.publicKey) {
  return instruction("create_vault", {
    vault_id: new BN(f.policy.vaultId.toString()),
    agent,
    max_trade_raw: new BN(f.policy.maxTradeRaw.toString()),
    budget_raw: new BN(f.policy.budgetRaw.toString()),
    expiry_unix: new BN(f.policy.expiryUnix.toString()),
  }, {
    owner: f.owner.publicKey, vault: f.vault, vault_authority: f.authority,
    input_mint: f.inputMint, output_mint: f.outputMint,
    input_vault: f.inputVault, output_vault: f.outputVault,
    token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    system_program: SystemProgram.programId,
  });
}

export function freshVault() {
  const f = createFixture();
  assertSuccess(send(f.svm, [createVaultInstruction(f)], [f.owner]));
  assertSuccess(send(f.svm, [
    createAssociatedTokenAccountInstruction(f.owner.publicKey, f.ownerInput, f.owner.publicKey, f.inputMint),
    createAssociatedTokenAccountInstruction(f.owner.publicKey, f.ownerOutput, f.owner.publicKey, f.outputMint),
    createMintToInstruction(f.inputMint, f.ownerInput, f.owner.publicKey, FUNDING),
    createTransferInstruction(f.ownerInput, f.inputVault, f.owner.publicKey, FUNDING),
  ], [f.owner]));
  return f;
}

export function revokeInstruction(f: Fixture, owner = f.owner.publicKey) {
  return instruction("revoke_agent", {}, { owner, vault: f.vault });
}

export function withdrawInstruction(f: Fixture, amount: bigint, overrides: Record<string, PublicKey> = {}) {
  return instruction("withdraw", { amount_raw: new BN(amount.toString()) }, {
    owner: f.owner.publicKey, vault: f.vault, vault_authority: f.authority,
    source: f.inputVault, destination: f.ownerInput, token_program: TOKEN_PROGRAM_ID,
    ...overrides,
  });
}
