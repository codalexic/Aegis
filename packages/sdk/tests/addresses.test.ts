import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID, derivePoolAuthorityPda, derivePoolPda,
  deriveSwapAccounts, deriveVaultAuthorityPda, deriveVaultPda, U64_MAX,
} from "@aegis/sdk";

const owner = new PublicKey(new Uint8Array(32).fill(3));
const input = new PublicKey(new Uint8Array(32).fill(1));
const output = new PublicKey(new Uint8Array(32).fill(2));
// Reference vectors use §2's literal seeds, including vault ID bytes [8,7,6,5,4,3,2,1].
const vaultId = 0x0102030405060708n;
const vault = new PublicKey("FDUBAkjEUChu67xZprWqknxZcveGDiTj5myU5xh23H1C");
const pool = new PublicKey("DNZgbzbkMzCBvdtKNPxpecSBdWAayqLm4mtKCAMpTAZu");

describe("interface PDA derivation", () => {
  it("uses the generated program IDs", () => {
    expect(AEGIS_PROGRAM_ID.toBase58()).toBe("E6QbymjuPGqyKeQBCo2rfXiRv1Bp55uM7yVYEDnzxDhe");
    expect(DEMO_DEX_PROGRAM_ID.toBase58()).toBe("BWsLwF3o7fzMmtGwp1qA2fC4sSTYt4BjzKQXCXHoEyNz");
  });

  it("derives all four PDAs with their canonical bumps and a full-width little-endian vault ID", () => {
    expect(deriveVaultPda(owner, vaultId)).toEqual([vault, 254]);
    expect(deriveVaultAuthorityPda(vault)).toEqual([new PublicKey("CqiwxyZXPT99LwiV8sRF8saR9HuEMgBw11q5WMceJa6Y"), 254]);
    expect(derivePoolPda(input, output)).toEqual([pool, 251]);
    expect(derivePoolAuthorityPda(pool)).toEqual([new PublicKey("BiDWLK3JadL7vu8assGaiH8AGT6XhuQMbj6aB7VEXcqy"), 253]);
  });

  it("derives original SPL Token ATAs for the vault and pool authorities", () => {
    const accounts = deriveSwapAccounts(vault, input, output);
    expect(accounts.inputVault.toBase58()).toBe("6ewFWhYXNewD7ekHUdrqtihbTtZXD8UqUHFQY3oP9aZ8");
    expect(accounts.outputVault.toBase58()).toBe("8bUnwzUM5Bm3hwnXwiXa171U7MG6Xti9A6zjzQ3Sz6wD");
    expect(accounts.inputReserve.toBase58()).toBe("HE2q8VgiQzyzzk8RTqnYCCRiae5193dpUihBkryU7AMD");
    expect(accounts.outputReserve.toBase58()).toBe("8VqVme8cnYmfyPVAS5Sm1PQ31AnFNe7mpxJKhD8i1QHF");
    expect(accounts.tokenProgram.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(accounts.demoDexProgram).toEqual(DEMO_DEX_PROGRAM_ID);
  });

  it("distinguishes owners, IDs, mint order and program namespaces", () => {
    expect(deriveVaultPda(input, vaultId)[0]).not.toEqual(vault);
    expect(deriveVaultPda(owner, vaultId + 1n)[0]).not.toEqual(vault);
    expect(deriveVaultPda(owner, vaultId, DEMO_DEX_PROGRAM_ID)[0]).not.toEqual(vault);
    expect(derivePoolPda(output, input)[0]).not.toEqual(pool);
    expect(derivePoolPda(input, output, AEGIS_PROGRAM_ID)[0]).not.toEqual(pool);
    expect(deriveVaultPda(owner, U64_MAX)[0]).not.toEqual(deriveVaultPda(owner, 0n)[0]);
  });

  it.each([-1n, U64_MAX + 1n])("rejects invalid vault ID %s", (id) => {
    expect(() => deriveVaultPda(owner, id)).toThrow();
  });
});
