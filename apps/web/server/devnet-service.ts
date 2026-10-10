import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { AnchorAegisClient } from "../../../packages/sdk/src/anchor";
import manifest from "../../../deployments/devnet.json";
import { ApiError } from "./http";

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
  const cutoff = Math.floor(now / 1000) - 3600;
  const [global, wallet] = await Promise.all([
    client.connection.getSignaturesForAddress(authority, { limit: 1000 }, "confirmed"),
    client.connection.getSignaturesForAddress(destination, { limit: 1 }, "confirmed"),
  ]);
  // Fail closed if the returned history cannot establish the hourly allowance.
  if (global.some((item) => item.blockTime === null || item.blockTime === undefined) ||
      (global.length === 1000 && global.at(-1)!.blockTime! >= cutoff)) throw new ApiError(503, "Faucet history is unavailable. Try again later.");
  if (global.filter((item) => !item.err && item.blockTime! > cutoff).length >= 10) throw new ApiError(429, "Faucet hourly limit reached (10 claims per hour). Try again later.");
  // Conservative: recent activity in the recipient ATA also starts the cooldown.
  if (wallet.some((item) => item.blockTime == null || item.blockTime > cutoff + 3000)) throw new ApiError(429, "Faucet limited: wait 10 minutes after the last activity in your testUSDC account.");
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
