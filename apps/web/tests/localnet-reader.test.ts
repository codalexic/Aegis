import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BN, type Idl } from "@coral-xyz/anchor";
import { BorshAccountsCoder } from "@coral-xyz/anchor/dist/esm/coder/borsh/accounts.js";
import { convertIdlToCamelCase } from "@coral-xyz/anchor/dist/esm/idl.js";
import { Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import idl from "../../../artifacts/idl/aegis.json";
import { AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID, deriveSwapAccounts, deriveVaultPda } from "../../../packages/sdk/src/addresses";
import type { LocalnetDeployment } from "../../../packages/sdk/src/anchor";
import { LocalnetReader } from "../src/localnet-reader";
import { AccountLayout, getAssociatedTokenAddressSync as browserAta } from "../src/browser-token";
import { isOnCurve } from "../src/browser-curve";

afterEach(() => vi.unstubAllGlobals());
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const owner = key(1), agent = key(2), inputMint = key(3), outputMint = key(4);
const [vault] = deriveVaultPda(owner, 0n);
const accounts = deriveSwapAccounts(vault, inputMint, outputMint);
const deployment: LocalnetDeployment = {
  environment: "localnet", rpcUrl: "http://127.0.0.1:8899", wsUrl: "ws://127.0.0.1:8900",
  programs: { aegis: AEGIS_PROGRAM_ID.toBase58(), demoDex: DEMO_DEX_PROGRAM_ID.toBase58() },
  owner: owner.toBase58(), agent: agent.toBase58(), inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
  pool: accounts.pool.toBase58(), poolAuthority: accounts.poolAuthority.toBase58(), inputReserve: accounts.inputReserve.toBase58(), outputReserve: accounts.outputReserve.toBase58(),
  ownerInput: getAssociatedTokenAddressSync(inputMint, owner, true).toBase58(), ownerOutput: getAssociatedTokenAddressSync(outputMint, owner, true).toBase58(),
};
const coder = new BorshAccountsCoder(convertIdlToCamelCase(idl as Idl));

async function fixture(overrides = {}) {
  const data = await coder.encode("vault", { owner, agent, vaultId: new BN(0), inputMint, outputMint, inputVault: accounts.inputVault, outputVault: accounts.outputVault,
    maxTradeRaw: new BN("50000000"), budgetRaw: new BN("100000000"), spentRaw: new BN("20000000"), expiryUnix: new BN(10_000), revoked: false, bump: 1, authorityBump: 1, ...overrides });
  const info = { owner: AEGIS_PROGRAM_ID.toBase58(), executable: false, data: [data.toString("base64"), "base64"] };
  const tokens = [inputMint, outputMint].map((mint) => {
    const bytes = Buffer.alloc(165); bytes.set(mint.toBytes()); bytes.set(accounts.vaultAuthority.toBytes(), 32);
    bytes.writeBigUInt64LE(9_007_199_254_740_993n, 64); bytes[108] = 1;
    return { owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, data: [bytes.toString("base64"), "base64"] };
  });
  vi.stubGlobal("fetch", vi.fn(async (_url, request) => {
    const { method } = JSON.parse(request.body);
    return Response.json({ result: { value: method === "getAccountInfo" ? info : tokens } });
  }));
  return { info, tokens, reader: new LocalnetReader(deployment) };
}

describe("browser read-only boundary", () => {
  it("reads bigint balances above JS's safe integer range using the generated IDL", async () => {
    const { reader, tokens } = await fixture();
    expect(await reader.getVault(vault)).toMatchObject({ inputBalanceRaw: 9_007_199_254_740_993n, outputBalanceRaw: 9_007_199_254_740_993n, spentRaw: 20_000_000n });
    expect(AccountLayout.decode(Buffer.from(tokens[0].data[0], "base64")).amount).toBe(9_007_199_254_740_993n);
  });

  it.each(["owner", "executable", "size", "discriminator"])("rejects invalid vault %s", async (field) => {
    const { reader, info } = await fixture();
    if (field === "owner") info.owner = agent.toBase58();
    if (field === "executable") info.executable = true;
    if (field === "size") info.data[0] = Buffer.alloc(2).toString("base64");
    if (field === "discriminator") { const bytes = Buffer.from(info.data[0], "base64"); bytes[0] ^= 1; info.data[0] = bytes.toString("base64"); }
    await expect(reader.getVault(vault)).rejects.toThrow("AccountMismatch");
  });

  it.each([{ inputVault: agent }, { owner: agent }])("rejects stored account/PDA mismatches", async (fields) => {
    const { reader } = await fixture(fields);
    await expect(reader.getVault(vault)).rejects.toThrow("AccountMismatch");
  });

  it.each(["program", "owner", "mint", "state", "size"])("rejects invalid token %s", async (field) => {
    const { reader, tokens } = await fixture();
    if (field === "program") tokens[0].owner = agent.toBase58();
    const bytes = Buffer.from(tokens[0].data[0], "base64");
    if (field === "owner") bytes.set(agent.toBytes(), 32);
    if (field === "mint") bytes.set(outputMint.toBytes());
    if (field === "state") bytes[108] = 0;
    tokens[0].data[0] = (field === "size" ? bytes.subarray(0, 100) : bytes).toString("base64");
    await expect(reader.getVault(vault)).rejects.toThrow("AccountMismatch");
  });

  it("rejects nonlocal RPC and mismatched deployments", () => {
    expect(() => new LocalnetReader({ ...deployment, rpcUrl: "https://example.com" })).toThrow();
    expect(() => new LocalnetReader({ ...deployment, pool: agent.toBase58() })).toThrow("DeploymentAccountMismatch");
  });

  it("matches the pinned SDK's curve checks and ATAs for keys and off-curve PDAs", () => {
    for (let i = 1; i <= 32; i++) {
      const identity = Keypair.generate().publicKey;
      const [pda] = deriveVaultPda(identity, BigInt(i));
      for (const address of [identity, pda, key(i)]) {
        expect(isOnCurve(address.toBytes())).toBe(PublicKey.isOnCurve(address.toBytes()));
        expect(browserAta(inputMint, address, true).toBase58()).toBe(getAssociatedTokenAddressSync(inputMint, address, true).toBase58());
      }
    }
  });

  it("decodes public transaction messages and program rejection logs", async () => {
    const signer = Keypair.generate();
    const tx = new Transaction({ recentBlockhash: key(9).toBase58(), feePayer: signer.publicKey }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: owner, lamports: 1n }));
    tx.sign(signer);
    const err = { InstructionError: [0, { Custom: 6004 }] };
    const logs = [`Program ${AEGIS_PROGRAM_ID} invoke [1]`, `Program ${AEGIS_PROGRAM_ID} failed: custom program error: 0x1774`];
    vi.stubGlobal("fetch", vi.fn(async (_url, request) => {
      const { method, params } = JSON.parse(request.body);
      if (method === "getSignaturesForAddress") return Response.json({ result: [{ signature: "public-signature", slot: 8, blockTime: 10, err }] });
      expect(params[1]).toMatchObject({ maxSupportedTransactionVersion: 1, encoding: "base64" });
      return Response.json({ result: { slot: 8, transaction: [tx.serialize().toString("base64"), "base64"], meta: { err, logMessages: logs }, version: "legacy" } });
    }));
    const reader = new LocalnetReader(deployment);
    const transaction = await reader.getTransaction("public-signature");
    expect(transaction?.transaction.message.getAccountKeys().get(0)?.equals(signer.publicKey)).toBe(true);
    expect(await reader.listActivity(vault)).toEqual([{ signature: "public-signature", slot: 8n, blockTime: 10n, ok: false, error: "CapExceeded" }]);
  });
});
