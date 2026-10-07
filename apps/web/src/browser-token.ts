import { PublicKey } from "@solana/web3.js";

// The browser only derives ATAs and reads original SPL Token account data.
// Keeping these reads separate avoids importing token transaction builders.
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associatedTokenProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey, allowOwnerOffCurve = false): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBytes())) throw new Error("TokenOwnerOffCurve");
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], associatedTokenProgram)[0];
}

export const AccountLayout = {
  span: 165,
  decode(bytes: Uint8Array) {
    if (bytes.length !== 165) throw new Error("Invalid token account size");
    return { mint: new PublicKey(bytes.subarray(0, 32)), owner: new PublicKey(bytes.subarray(32, 64)),
      amount: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true), state: bytes[108] };
  },
};
