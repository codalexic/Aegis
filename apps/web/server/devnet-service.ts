import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorAegisClient } from "../../../packages/sdk/src/anchor";
import manifest from "../../../deployments/devnet.json";
import { ApiError, rateLimitError } from "./http";

// No filesystem, .env loading, caller-selected deployment or localnet signing.
export const deployment = manifest;

export function environmentSigner(env: NodeJS.ProcessEnv, name: "AEGIS_AGENT_SECRET" | "AEGIS_FAUCET_SECRET", expected: string): Keypair {
  try {
    const bytes: unknown = JSON.parse(env[name] ?? "");
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
    const signer = Keypair.fromSecretKey(Uint8Array.from(bytes));
    if (signer.publicKey.toBase58() !== expected) throw new Error();
    return signer;
  } catch { throw new ApiError(503, `${name} is missing or does not match the devnet deployment.`); }
}

export function devnetClient() {
  if (deployment.environment !== "devnet") throw new ApiError(503, "Public deployment must be devnet.");
  return new AnchorAegisClient({ deployment });
}

/** Confirmed history survives cold starts. Pending claims on separate instances can race. */
export async function checkFaucetHistory(client: AnchorAegisClient, authority: PublicKey, destination: PublicKey, now = Date.now()) {
  const cutoff = now / 1000 - 3600;
  const history = await client.connection.getSignaturesForAddress(authority, { limit: 1000 }, "confirmed");
  // Fail closed if the returned history cannot establish the hourly allowance.
  const unavailable = () => new ApiError(503, "Faucet history is unavailable. Try again later.");
  if (history.some((item) => item.blockTime == null) ||
      (history.length === 1000 && history.at(-1)!.blockTime! > cutoff)) throw unavailable();
  const recent = history.filter((item) => !item.err && item.blockTime! > cutoff);
  const transactions = recent.length ? await client.connection.getParsedTransactions(recent.map((item) => item.signature), {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  }) : [];
  if (transactions.length !== recent.length) throw unavailable();
  const claims: number[] = [];
  let walletWait = 0;
  for (const [index, transaction] of transactions.entries()) {
    if (!transaction?.meta) throw unavailable();
    if (transaction.meta.err) continue;
    const message = transaction.transaction.message;
    if (!message.accountKeys.some((key) => key.signer && key.pubkey.equals(authority))) continue;
    const instructions = [...message.instructions, ...(transaction.meta.innerInstructions ?? []).flatMap((group) => group.instructions)];
    const mints = instructions.filter((instruction) => instruction.programId.equals(TOKEN_PROGRAM_ID) && "parsed" in instruction &&
      ["mintTo", "mintToChecked"].includes(instruction.parsed?.type) &&
      instruction.parsed.info?.mint === deployment.inputMint && instruction.parsed.info?.mintAuthority === authority.toBase58());
    if (!mints.length) continue;
    const at = recent[index].blockTime! * 1000;
    claims.push(at);
    if (mints.some((instruction) => "parsed" in instruction && instruction.parsed.info.account === destination.toBase58())) {
      walletWait = Math.max(walletWait, at + 600_000 - now);
    }
  }
  // More than the cap can exist after concurrent cold-start claims. Wait until fewer than 30 remain.
  claims.sort((a, b) => b - a);
  const hourlyWait = claims.length < 30 ? 0 : claims[29] + 3_600_000 - now;
  if (hourlyWait > 0 && hourlyWait >= walletWait) throw rateLimitError("Faucet hourly limit reached. Try again in", hourlyWait);
  if (walletWait > 0) throw rateLimitError("This wallet can claim again in", walletWait);
}

export async function mintTestUsdc(env: NodeJS.ProcessEnv, recipient: PublicKey) {
  if (!deployment.faucet || deployment.faucet === deployment.owner) throw new ApiError(503, "A dedicated faucet authority is required.");
  const authority = environmentSigner(env, "AEGIS_FAUCET_SECRET", deployment.faucet);
  const client = devnetClient();
  const mint = new PublicKey(deployment.inputMint);
  const state = await getMint(client.connection, mint, "confirmed");
  if (state.decimals !== 6 || !state.mintAuthority?.equals(authority.publicKey)) throw new ApiError(503, "Faucet mint configuration mismatch.");
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  await checkFaucetHistory(client, authority.publicKey, destination);
  const transaction = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, destination, recipient, mint),
    createMintToCheckedInstruction(mint, destination, authority.publicKey, 1_000_000_000n, 6),
  );
  const signature = await sendAndConfirmTransaction(client.connection, transaction, [authority], { commitment: "confirmed" });
  return { signature, amountRaw: "1000000000" };
}
