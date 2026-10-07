import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import aegisIdl from "../../../artifacts/idl/aegis.json";
import dexIdl from "../../../artifacts/idl/demo_dex.json";
import { isU64 } from "./amounts";
import type { SwapAccounts } from "./types";

export const AEGIS_PROGRAM_ID = new PublicKey(aegisIdl.address);
export const DEMO_DEX_PROGRAM_ID = new PublicKey(dexIdl.address);
const encoder = new TextEncoder();

export function deriveVaultPda(owner: PublicKey, vaultId: bigint, programId = AEGIS_PROGRAM_ID): [PublicKey, number] {
  if (!isU64(vaultId)) throw new RangeError("Vault ID must fit in u64.");
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, vaultId, true);
  return PublicKey.findProgramAddressSync([encoder.encode("vault"), owner.toBytes(), idBytes], programId);
}

export function deriveVaultAuthorityPda(vault: PublicKey, programId = AEGIS_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([encoder.encode("authority"), vault.toBytes()], programId);
}

export function derivePoolPda(inputMint: PublicKey, outputMint: PublicKey, programId = DEMO_DEX_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([encoder.encode("pool"), inputMint.toBytes(), outputMint.toBytes()], programId);
}

export function derivePoolAuthorityPda(pool: PublicKey, programId = DEMO_DEX_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([encoder.encode("pool-authority"), pool.toBytes()], programId);
}

export function deriveSwapAccounts(vault: PublicKey, inputMint: PublicKey, outputMint: PublicKey): SwapAccounts {
  const [vaultAuthority] = deriveVaultAuthorityPda(vault);
  const [pool] = derivePoolPda(inputMint, outputMint);
  const [poolAuthority] = derivePoolAuthorityPda(pool);
  return {
    vault, vaultAuthority, pool, poolAuthority,
    inputVault: getAssociatedTokenAddressSync(inputMint, vaultAuthority, true),
    outputVault: getAssociatedTokenAddressSync(outputMint, vaultAuthority, true),
    inputReserve: getAssociatedTokenAddressSync(inputMint, poolAuthority, true),
    outputReserve: getAssociatedTokenAddressSync(outputMint, poolAuthority, true),
    demoDexProgram: DEMO_DEX_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}
