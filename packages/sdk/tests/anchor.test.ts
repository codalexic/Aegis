import { ASSOCIATED_TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, type Signer } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import idl from "../../../artifacts/idl/aegis.json";
import localnet from "../../../deployments/localnet.json";
import { AEGIS_PROGRAM_ID, AnchorAegisClient, createClient, DEMO_DEX_PROGRAM_ID, U64_MAX } from "../src/index";
import { errorLogs, fixture, info, instructionCoder, PRECISE_AMOUNT, tokenData, transactionRecord } from "./anchor-helpers";

afterEach(() => vi.restoreAllMocks());

describe("real Anchor client configuration and reads", () => {
  it("factory returns a wallet-free localnet client using deployment addresses", () => {
    const client = createClient("localnet");
    expect(client).toBeInstanceOf(AnchorAegisClient);
    expect(client.environment).toBe("localnet");
    expect((client as AnchorAegisClient).connection.rpcEndpoint).toBe(localnet.rpcUrl);
  });

  it("rejects non-local endpoints and mismatched deployment accounts/programs", () => {
    expect(() => new AnchorAegisClient({ deployment: { ...localnet, rpcUrl: "https://api.mainnet-beta.solana.com" } })).toThrow("loopback");
    expect(() => new AnchorAegisClient({ deployment: { ...localnet, wsUrl: "wss://remote.invalid" } })).toThrow("loopback");
    expect(() => new AnchorAegisClient({ connection: new Connection("https://remote.invalid") })).toThrow("loopback");
    expect(() => new AnchorAegisClient({ deployment: { ...localnet, programs: { ...localnet.programs, aegis: SystemProgram.programId.toBase58() } } })).toThrow("DeploymentProgramMismatch");
    expect(() => new AnchorAegisClient({ deployment: { ...localnet, inputReserve: localnet.outputReserve } })).toThrow("DeploymentAccountMismatch");
  });

  it("decodes generated-IDL state and exact bigint balances without a signer", async () => {
    const f = await fixture();
    expect(await f.client.getVault(f.vault)).toEqual({
      address: f.vault, owner: f.owner.publicKey, agent: f.agent.publicKey, inputMint: f.inputMint, outputMint: f.outputMint,
      maxTradeRaw: f.policy.maxTradeRaw, budgetRaw: PRECISE_AMOUNT, spentRaw: 20_000_000n, expiryUnix: f.policy.expiryUnix,
      revoked: false, inputBalanceRaw: PRECISE_AMOUNT, outputBalanceRaw: 200_000_000n,
    });
    expect(f.getAccountInfo).toHaveBeenCalledWith(f.vault, "confirmed");
    expect(f.getMultipleAccountsInfo).toHaveBeenCalledWith([f.accounts.inputVault, f.accounts.outputVault], "confirmed");
    expect(f.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each(["missing", "owner", "length", "discriminator", "address", "stored-token-account"])("rejects a bad vault: %s", async (kind) => {
    const f = await fixture();
    if (kind === "missing") f.getAccountInfo.mockResolvedValue(null);
    if (kind === "owner") f.getAccountInfo.mockResolvedValue({ ...f.vaultInfo, owner: TOKEN_PROGRAM_ID });
    if (kind === "length") f.getAccountInfo.mockResolvedValue(info(f.vaultInfo.data.subarray(0, 10)));
    if (kind === "discriminator") f.getAccountInfo.mockResolvedValue(info(Buffer.alloc(f.vaultInfo.data.length)));
    if (kind === "address") await f.setVault({ owner: f.agent.publicKey });
    if (kind === "stored-token-account") await f.setVault({ input_vault: f.accounts.outputVault });
    await expect(f.client.getVault(f.vault)).rejects.toThrow(kind === "missing" ? "VaultNotFound" : "AccountMismatch");
  });

  it.each(["missing", "program", "mint", "authority", "length"])("rejects bad token data: %s", async (kind) => {
    const f = await fixture();
    const input = tokenData(kind === "mint" ? f.outputMint : f.inputMint, kind === "authority" ? f.owner.publicKey : f.accounts.vaultAuthority, 1n);
    if (kind === "program") input.owner = AEGIS_PROGRAM_ID;
    if (kind === "length") input.data = Buffer.alloc(2);
    f.getMultipleAccountsInfo.mockResolvedValue([kind === "missing" ? null : input, tokenData(f.outputMint, f.accounts.vaultAuthority, 1n)]);
    await expect(f.client.getVault(f.vault)).rejects.toThrow("AccountMismatch");
  });
});

describe("IDL-typed instructions and signing", () => {
  it("creates a vault with exact u64 arguments, all final accounts and only the owner signature", async () => {
    const f = await fixture();
    const result = await f.client.createVault(f.owner, f.policy);
    expect(result).toMatchObject({ ok: true, vault: f.vault });
    const tx = f.sent[0];
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer).toEqual(f.owner.publicKey);
    expect(tx.signatures.map((item) => item.publicKey)).toEqual([f.owner.publicKey]);
    expect(tx.recentBlockhash).toBe(f.lifetime.blockhash);
    const ix = tx.instructions[0];
    expect(ix.programId).toEqual(AEGIS_PROGRAM_ID);
    const decoded = instructionCoder.decode(ix.data)!;
    expect(decoded.name).toBe("create_vault");
    const data = decoded.data as Record<string, { toString(): string }>;
    expect(data.vault_id.toString()).toBe(PRECISE_AMOUNT.toString());
    expect(data.budget_raw.toString()).toBe(PRECISE_AMOUNT.toString());
    expect(data.expiry_unix.toString()).toBe(f.policy.expiryUnix.toString());
    expect(ix.keys.map((key) => key.pubkey)).toEqual([
      f.owner.publicKey, f.vault, f.accounts.vaultAuthority, f.inputMint, f.outputMint,
      f.accounts.inputVault, f.accounts.outputVault, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId,
    ]);
    expect(f.confirmTransaction).toHaveBeenCalledWith({ signature: result.signature, ...f.lifetime }, "confirmed");
  });

  it("funds with a checked SPL transfer and references the vault for activity discovery", async () => {
    const f = await fixture();
    expect(await f.client.fundVault(f.owner, f.vault, PRECISE_AMOUNT)).toMatchObject({ ok: true });
    const tx = f.sent[0];
    expect(tx.instructions).toHaveLength(1);
    const decoded = decodeTransferCheckedInstruction(tx.instructions[0]);
    expect(decoded.data).toMatchObject({ amount: PRECISE_AMOUNT, decimals: 6 });
    expect(decoded.keys.source.pubkey).toEqual(getAssociatedTokenAddressSync(f.inputMint, f.owner.publicKey));
    expect(decoded.keys.destination.pubkey).toEqual(f.accounts.inputVault);
    expect(tx.instructions[0].keys.at(-1)).toEqual({ pubkey: f.vault, isSigner: false, isWritable: false });
  });

  it("normal swap resolves vault/deployment accounts, uses the agent, and sends over-cap amounts unchanged", async () => {
    const f = await fixture();
    expect(await f.client.swap(f.agent, f.vault, 60_000_000n)).toMatchObject({ ok: true });
    const tx = f.sent[0];
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer).toEqual(f.agent.publicKey);
    expect(tx.signatures.map((item) => item.publicKey)).toEqual([f.agent.publicKey]);
    const ix = tx.instructions[0];
    expect(instructionCoder.decode(ix.data)?.name).toBe("execute_swap");
    expect(ix.data.readBigUInt64LE(8)).toBe(60_000_000n);
    expect(ix.keys.map((item) => item.pubkey)).toEqual([
      f.agent.publicKey, f.vault, f.accounts.vaultAuthority, f.accounts.inputVault, f.accounts.outputVault,
      f.accounts.pool, f.accounts.poolAuthority, f.accounts.inputReserve, f.accounts.outputReserve, DEMO_DEX_PROGRAM_ID, TOKEN_PROGRAM_ID,
    ]);
    expect(f.sendRawTransaction).toHaveBeenCalledWith(expect.any(Buffer), { skipPreflight: true, maxRetries: 3 });
  });

  it.each(["vault", "vaultAuthority", "inputVault", "outputVault", "pool", "poolAuthority", "inputReserve", "outputReserve", "demoDexProgram", "tokenProgram"] as const)(
    "swapRaw preserves caller-selected %s without account reads or resolution", async (field) => {
      const f = await fixture();
      const chosen = { ...f.accounts, [field]: new PublicKey(new Uint8Array(32).fill(11)) };
      expect(await f.client.swapRaw(f.owner, chosen, 0n)).toMatchObject({ ok: true });
      expect(f.getAccountInfo).not.toHaveBeenCalled();
      expect(f.getMultipleAccountsInfo).not.toHaveBeenCalled();
      const ix = f.sent[0].instructions[0];
      const name = field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
      const index = idl.instructions.find((instruction) => instruction.name === "execute_swap")!.accounts.findIndex((account) => account.name === name);
      expect(ix.keys[index].pubkey).toEqual(chosen[field]);
      expect(ix.keys[0].pubkey).toEqual(f.owner.publicKey); // Wrong signer also goes to the program.
      expect(ix.data.readBigUInt64LE(8)).toBe(0n); // Zero is a program check, not a client filter.
    },
  );

  it("revoke requires only the supplied owner's signature and does not fetch/check policy", async () => {
    const f = await fixture();
    expect(await f.client.revoke(f.owner, f.vault)).toMatchObject({ ok: true });
    expect(f.getAccountInfo).not.toHaveBeenCalled();
    const ix = f.sent[0].instructions[0];
    expect(instructionCoder.decode(ix.data)?.name).toBe("revoke_agent");
    expect(ix.keys.map((item) => item.pubkey)).toEqual([f.owner.publicKey, f.vault]);
  });

  it.each(["new", "default", "owner", "current agent"])("sends the %s replacement to rotate_agent with only the owner signature", async (kind) => {
    const f = await fixture();
    const newAgent = kind === "default" ? PublicKey.default : kind === "owner" ? f.owner.publicKey
      : kind === "current agent" ? f.agent.publicKey : new PublicKey(new Uint8Array(32).fill(11));
    const result = await f.client.rotateAgent(f.owner, f.vault, newAgent);
    // Stubbed RPC accepts the transaction; replacement validity is checked on-chain.
    expect(result).toMatchObject({ ok: true });
    expect(f.getAccountInfo).not.toHaveBeenCalled();
    expect(f.getMultipleAccountsInfo).not.toHaveBeenCalled();
    const tx = f.sent[0];
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer).toEqual(f.owner.publicKey);
    expect(tx.signatures.map((item) => item.publicKey)).toEqual([f.owner.publicKey]);
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0];
    expect(ix.programId).toEqual(AEGIS_PROGRAM_ID);
    expect(instructionCoder.decode(ix.data)).toEqual({ name: "rotate_agent", data: { new_agent: newAgent } });
    expect(ix.keys.map((item) => item.pubkey)).toEqual([f.owner.publicKey, f.vault]);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1]).toMatchObject({ isSigner: false, isWritable: true });
    expect(f.confirmTransaction).toHaveBeenCalledWith({ signature: result.signature, ...f.lifetime }, "confirmed");
  });

  it("returns controlled signing and RPC errors from rotation", async () => {
    const f = await fixture();
    const newAgent = new PublicKey(new Uint8Array(32).fill(11));
    const signer: Signer = { publicKey: f.owner.publicKey, get secretKey(): Uint8Array { throw new Error("sensitive signing context"); } };
    expect(await f.client.rotateAgent(signer, f.vault, newAgent))
      .toEqual({ ok: false, error: "SigningFailed", origin: "client" });
    expect(f.sendRawTransaction).not.toHaveBeenCalled();
    f.confirmTransaction.mockRejectedValue(new Error("sensitive RPC context"));
    expect(await f.client.rotateAgent(f.owner, f.vault, newAgent))
      .toEqual({ ok: false, error: "RpcError", origin: "rpc", signature: expect.any(String) });
  });

  it.each(["input", "output"])("withdraws %s after revocation/expiry and creates the owner's destination ATA", async (side) => {
    const f = await fixture();
    await f.setVault({ revoked: true, expiry_unix: f.raw.spent_raw });
    const mint = side === "input" ? f.inputMint : f.outputMint;
    expect(await f.client.withdraw(f.owner, f.vault, mint, PRECISE_AMOUNT)).toMatchObject({ ok: true });
    const [ata, withdraw] = f.sent[0].instructions;
    expect(ata.programId).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(ata.data).toEqual(Buffer.from([1]));
    expect(instructionCoder.decode(withdraw.data)?.name).toBe("withdraw");
    expect(withdraw.data.readBigUInt64LE(8)).toBe(PRECISE_AMOUNT);
    expect(withdraw.keys.map((key) => key.pubkey)).toEqual([
      f.owner.publicKey, f.vault, f.accounts.vaultAuthority, side === "input" ? f.accounts.inputVault : f.accounts.outputVault,
      getAssociatedTokenAddressSync(mint, f.owner.publicKey), TOKEN_PROGRAM_ID,
    ]);
  });

  it.each([-1n, U64_MAX + 1n, 20 as unknown as bigint])("rejects unrepresentable wire amounts before signing: %s", async (amount) => {
    const f = await fixture();
    expect(await f.client.swapRaw(f.agent, f.accounts, amount)).toEqual({ ok: false, error: "InvalidAmount", origin: "client" });
    expect(f.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not expose key/signing or RPC exception text", async () => {
    const f = await fixture();
    const signer: Signer = { publicKey: f.owner.publicKey, get secretKey(): Uint8Array { throw new Error("sensitive signing context"); } };
    expect(await f.client.revoke(signer, f.vault)).toEqual({ ok: false, error: "SigningFailed", origin: "client" });
    f.getLatestBlockhash.mockRejectedValue(new Error("sensitive RPC context"));
    expect(await f.client.revoke(f.owner, f.vault)).toEqual({ ok: false, error: "RpcError", origin: "rpc" });
  });
});

describe("confirmation and program errors", () => {
  it.each(["Unauthorized", "InvalidAmount"])("maps a confirmed rotation rejection to %s and preserves its signature", async (name) => {
    const f = await fixture();
    const { code } = idl.errors.find((error) => error.name === name)!;
    const err = { InstructionError: [0, { Custom: code }] };
    f.confirmTransaction.mockResolvedValue({ context: { slot: 12 }, value: { err } });
    f.getTransaction.mockImplementation(async () => transactionRecord(f.sent[0], err, errorLogs(AEGIS_PROGRAM_ID, code)));
    const signer = name === "Unauthorized" ? f.agent : f.owner;
    const result = await f.client.rotateAgent(signer, f.vault, PublicKey.default);
    expect(f.sent[0].signatures.map((item) => item.publicKey)).toEqual([signer.publicKey]);
    expect(result).toEqual({ ok: false, error: name, origin: "program", signature: expect.any(String) });
    expect(result.signature).not.toMatch(/^mock-/);
    expect(f.getTransaction).toHaveBeenCalledWith(result.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  });

  it.each(idl.errors)("maps confirmed $name from code $code using the IDL", async ({ code, name }) => {
    const f = await fixture();
    const err = { InstructionError: [0, { Custom: code }] };
    f.confirmTransaction.mockResolvedValue({ context: { slot: 12 }, value: { err } });
    f.getTransaction.mockImplementation(async () => transactionRecord(f.sent[0], err, errorLogs(AEGIS_PROGRAM_ID, code)));
    const result = await f.client.swapRaw(f.agent, f.accounts, 20_000_000n);
    expect(result).toEqual({ ok: false, error: name, origin: "program", signature: expect.any(String) });
    expect(result.signature).not.toMatch(/^mock-/);
    expect(f.getTransaction).toHaveBeenCalledWith(result.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  });

  it("keeps DEX 6001 as InsufficientReserve rather than mislabelling it Revoked", async () => {
    const f = await fixture();
    const err = { InstructionError: [0, { Custom: 6001 }] };
    f.confirmTransaction.mockResolvedValue({ context: { slot: 12 }, value: { err } });
    const logs = [`Program ${AEGIS_PROGRAM_ID} invoke [1]`, ...errorLogs(DEMO_DEX_PROGRAM_ID, 6001), `Program ${AEGIS_PROGRAM_ID} failed: custom program error: 0x1771`];
    f.getTransaction.mockImplementation(async () => transactionRecord(f.sent[0], err, logs));
    expect(await f.client.swapRaw(f.agent, f.accounts, 20n)).toMatchObject({ ok: false, error: "InsufficientReserve", origin: "program" });
  });

  it("preserves the real signature on confirmation failure without claiming a program rejection", async () => {
    const f = await fixture();
    f.confirmTransaction.mockRejectedValue(new Error("Timeout"));
    expect(await f.client.revoke(f.owner, f.vault)).toMatchObject({ ok: false, signature: expect.any(String), error: "RpcError", origin: "rpc" });
    expect(f.sent).toHaveLength(1);
  });

  it("reports confirmed failure even if transaction logs are unavailable, without guessing the program", async () => {
    const f = await fixture();
    f.confirmTransaction.mockResolvedValue({ context: { slot: 12 }, value: { err: { InstructionError: [0, { Custom: 6001 }] } } });
    f.getTransaction.mockRejectedValue(new Error("RPC unavailable"));
    expect(await f.client.swapRaw(f.agent, f.accounts, 20n)).toMatchObject({ ok: false, error: "CustomProgramError(6001)", origin: "program", signature: expect.any(String) });
  });
});
