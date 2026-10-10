import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint, createMint,
  getAccount, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { SystemProgram, Transaction, sendAndConfirmTransaction, type Connection, type Keypair } from "@solana/web3.js";
import type { DemoDex } from "../../artifacts/idl/demo_dex";
import dexIdl from "../../artifacts/idl/demo_dex.json";
import { DEMO_DEX_PROGRAM_ID, deriveSwapAccounts } from "../../packages/sdk/src/addresses";
import { DevnetError } from "./support";

const { Program, AnchorProvider, Wallet } = (Reflect.get(anchor, "default") ?? anchor) as typeof anchor;
const options = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;
export const POOL_LIQUIDITY = 100_000_000_000_000n;
export const OWNER_TOKENS = 10_000_000_000n;

export async function seedDevnet(connection: Connection, owner: Keypair, faucet: Keypair, agent: Keypair,
  input: Keypair, output: Keypair, agentFunding: bigint) {
  if (faucet.publicKey.equals(owner.publicKey)) throw new DevnetError("A dedicated faucet authority is required.");
  for (const [key, decimals, authority] of [[input, 6, faucet], [output, 9, owner]] as const) {
    if (!await connection.getAccountInfo(key.publicKey, "confirmed")) {
      await createMint(connection, owner, authority.publicKey, null, decimals, key, options);
    }
    const mint = await getMint(connection, key.publicKey, "confirmed");
    if (mint.decimals !== decimals || !mint.mintAuthority?.equals(authority.publicKey) || mint.freezeAuthority !== null) {
      throw new DevnetError("Existing devnet mint has unexpected decimals or authority; left unchanged.");
    }
  }
  const dex = new Program<DemoDex>(dexIdl as DemoDex, new AnchorProvider(connection, new Wallet(owner), options));
  const accounts = deriveSwapAccounts(owner.publicKey, input.publicKey, output.publicKey);
  if (!await connection.getAccountInfo(accounts.pool, "confirmed")) {
    await dex.methods.initializePool().accountsStrict({
      payer: owner.publicKey, inputMint: input.publicKey, outputMint: output.publicKey,
      pool: accounts.pool, poolAuthority: accounts.poolAuthority,
      inputReserve: accounts.inputReserve, outputReserve: accounts.outputReserve,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  }
  const poolInfo = await connection.getAccountInfo(accounts.pool, "confirmed");
  if (!poolInfo?.owner.equals(DEMO_DEX_PROGRAM_ID)) throw new DevnetError("Unexpected pool owner.");
  const pool = await dex.account.pool.fetch(accounts.pool);
  if (!pool.inputMint.equals(input.publicKey) || !pool.outputMint.equals(output.publicKey) ||
      !pool.inputReserve.equals(accounts.inputReserve) || !pool.outputReserve.equals(accounts.outputReserve)) {
    throw new DevnetError("Existing pool does not match the deployment mints/reserves.");
  }
  const ownerInput = await getOrCreateAssociatedTokenAccount(connection, owner, input.publicKey, owner.publicKey, false, "confirmed", options);
  await getOrCreateAssociatedTokenAccount(connection, owner, output.publicKey, owner.publicKey, false, "confirmed", options);
  if (ownerInput.amount < OWNER_TOKENS) {
    await mintTo(connection, owner, input.publicKey, ownerInput.address, faucet, OWNER_TOKENS - ownerInput.amount, [], options);
  }
  const reserve = await getAccount(connection, accounts.outputReserve, "confirmed");
  if (!reserve.owner.equals(accounts.poolAuthority) || !reserve.mint.equals(output.publicKey)) throw new DevnetError("Unexpected pool reserve.");
  if (reserve.amount < POOL_LIQUIDITY) {
    await mintTo(connection, owner, output.publicKey, accounts.outputReserve, owner, POOL_LIQUIDITY - reserve.amount, [], options);
  }
  if (agentFunding > 0n) {
    await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: agent.publicKey, lamports: agentFunding,
    })), [owner], options);
  }
}
