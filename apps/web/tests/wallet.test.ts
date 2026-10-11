import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { WalletAegisClient, type WalletSigner } from "../../../packages/sdk/src/wallet";
import { encode as encodeSignature } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { WalletTransaction } from "../../../packages/sdk/src/wallet-transaction";
import deployment from "../../../deployments/localnet.json";
import { DEVNET_RPC_URL, DEVNET_WS_URL } from "../../../packages/sdk/src/devnet";
import { RPC_RATE_LIMITED, WALLET_REJECTED } from "../../../packages/sdk/src/errors";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const owner = Keypair.generate();
const params = { vaultId: 9_007_199_254_740_993n, agent: new PublicKey(deployment.agent), maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: 1_900_000_000n };

function fixture(environment: "devnet" | "localnet" = "devnet") {
  const client = new WalletAegisClient({ ...deployment, environment,
    ...(environment === "devnet" && { rpcUrl: DEVNET_RPC_URL, wsUrl: DEVNET_WS_URL }) });
  const rpc = vi.spyOn(client, "rpc").mockImplementation(async (method, args) => {
    if (method === "getLatestBlockhash") return { value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 } };
    if (method === "simulateTransaction") return { value: { err: null } };
    if (method === "sendTransaction") return encodeSignature(VersionedTransaction.deserialize(Buffer.from(args[0] as string, "base64")).signatures[0]);
    if (method === "getSignatureStatuses") return { value: [{ err: null, confirmationStatus: "confirmed" }] };
    throw new Error(`Unexpected RPC ${method}`);
  });
  const sign = vi.fn<WalletSigner["signTransaction"]>(async (transaction) => {
    const signed = VersionedTransaction.deserialize(transaction.serialize());
    signed.sign([owner]);
    return signed;
  });
  return { client, rpc, sign, wallet: { publicKey: owner.publicKey, signTransaction: sign } };
}

describe("wallet-adapter owner signing", () => {
  it.each(["devnet", "localnet"] as const)("builds, simulates, asks the wallet, sends and confirms on %s", async (environment) => {
    const { client, rpc, wallet, sign } = fixture(environment);
    const result = await client.createVault(wallet, params);
    expect(result).toMatchObject({ ok: true, signature: expect.any(String), vault: expect.any(PublicKey) });
    expect(sign).toHaveBeenCalledTimes(1);
    const unsigned = sign.mock.calls[0][0];
    expect(unsigned.signatures[0].every((byte) => byte === 0)).toBe(true);
    expect(unsigned.message.staticAccountKeys[0].equals(owner.publicKey)).toBe(true);
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(["getLatestBlockhash", "simulateTransaction", "sendTransaction", "getSignatureStatuses"]);
    const sent = rpc.mock.calls.find(([method]) => method === "sendTransaction")![1][0] as string;
    const wire = VersionedTransaction.deserialize(Buffer.from(sent, "base64"));
    expect(wire.signatures[0].some((byte) => byte !== 0)).toBe(true);
    const instruction = TransactionMessage.decompile(wire.message).instructions[0];
    expect(instruction.data.readBigUInt64LE(8)).toBe(params.vaultId);
    expect(instruction.keys.filter((key) => key.isSigner).map((key) => key.pubkey)).toEqual([owner.publicKey]);
    // Our public envelope must match upstream wire serialization exactly.
    expect(unsigned.serialize()).toEqual(new VersionedTransaction(unsigned.message).serialize());
    expect(() => (unsigned as WalletTransaction).sign([owner])).toThrow("connected wallet");
  });

  it.each([
    ["wallet error", "WalletSigningError"], ["unsigned", "InvalidWalletSignature"],
    ["changed message", "WalletModifiedTransaction"], ["wrong signer", "InvalidWalletSignature"],
  ])("does not submit when signing is %s", async (kind, error) => {
    const { client, rpc, wallet, sign } = fixture();
    sign.mockImplementation(async (transaction) => {
      if (kind === "wallet error") throw new Error("Wallet connection timed out.");
      if (kind === "changed message") transaction.message.recentBlockhash = owner.publicKey.toBase58();
      if (kind === "wrong signer") {
        const key = Keypair.generate();
        const other = VersionedTransaction.deserialize(transaction.serialize());
        other.message.staticAccountKeys[0] = key.publicKey; other.sign([key]);
        transaction.signatures[0] = other.signatures[0];
      }
      return transaction;
    });
    expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, origin: "client", error,
      ...(kind === "wallet error" && { detail: "Wallet connection timed out." }) });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it.each(["prepend", "append", "mutate in place"])("submits the exact signed bytes when Phantom adds bounded ComputeBudget instructions: %s", async (kind) => {
    const { client, rpc, wallet, sign } = fixture();
    let walletBytes: Uint8Array;
    sign.mockImplementation(async (transaction) => {
      const message = TransactionMessage.decompile(transaction.message);
      const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000n })];
      message.instructions = kind === "append" ? [...message.instructions, ...budget] : [...budget, ...message.instructions];
      const signed = new VersionedTransaction(message.compileToV0Message());
      signed.sign([owner]);
      walletBytes = signed.serialize();
      if (kind === "mutate in place") {
        transaction.message = signed.message;
        transaction.signatures = signed.signatures;
        return transaction;
      }
      return signed;
    });
    const result = await client.createVault(wallet, params);
    expect(result.ok).toBe(true);
    const sent = rpc.mock.calls.find(([method]) => method === "sendTransaction")![1][0];
    expect(sent).toBe(Buffer.from(walletBytes!).toString("base64"));
    expect(result.signature).toBe(encodeSignature(VersionedTransaction.deserialize(walletBytes!).signatures[0]));
  });

  it.each(["instruction data", "instruction removed", "program", "account", "payer", "blockhash"])("rejects a wallet change to %s before submission", async (kind) => {
    const { client, rpc, wallet, sign } = fixture();
    sign.mockImplementation(async (transaction) => {
      const message = TransactionMessage.decompile(transaction.message);
      const other = Keypair.generate();
      if (kind === "instruction data") message.instructions[0].data[8] ^= 1;
      if (kind === "instruction removed") message.instructions = [];
      if (kind === "program") message.instructions[0].programId = other.publicKey;
      if (kind === "account") message.instructions[0].keys[1].pubkey = other.publicKey;
      if (kind === "payer") message.payerKey = other.publicKey;
      if (kind === "blockhash") message.recentBlockhash = other.publicKey.toBase58();
      const signed = new VersionedTransaction(message.compileToV0Message());
      signed.sign(kind === "payer" ? [other, owner] : [owner]);
      return signed;
    });
    expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, origin: "client", error: "WalletModifiedTransaction" });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it.each(["missing", "unsupported Ed25519"])("verifies signatures with WebCrypto %s", async (kind) => {
    const subtle = { importKey: vi.fn(() => { throw new Error("Ed25519 is unsupported"); }), verify: vi.fn(() => { throw new Error("Ed25519 is unsupported"); }) };
    vi.stubGlobal("crypto", kind === "missing" ? undefined : { subtle });
    const { client, wallet } = fixture();
    expect(await client.createVault(wallet, params)).toMatchObject({ ok: true });
    expect(subtle.importKey).not.toHaveBeenCalled();
    expect(subtle.verify).not.toHaveBeenCalled();
  });

  it.each(["short", "extra", "corrupt"])("rejects %s signatures", async (kind) => {
    const { client, rpc, wallet, sign } = fixture();
    const original = sign.getMockImplementation()!;
    sign.mockImplementation(async (transaction) => {
      const signed = await original(transaction);
      if (kind === "short") signed.signatures[0] = new Uint8Array(63);
      if (kind === "extra") signed.signatures.push(signed.signatures[0]);
      if (kind === "corrupt") signed.signatures[0][0] ^= 1;
      return signed;
    });
    expect(await client.createVault(wallet, params)).toEqual({ ok: false, origin: "client", error: "InvalidWalletSignature" });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it("rejects serialized bytes that differ from the validated wallet message", async () => {
    const { client, rpc, wallet, sign } = fixture();
    const original = sign.getMockImplementation()!;
    sign.mockImplementation(async (transaction) => {
      const signed = await original(transaction);
      const bytes = signed.serialize(); bytes[bytes.length - 1] ^= 1;
      signed.serialize = () => bytes;
      return signed;
    });
    expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, error: "WalletModifiedTransaction" });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it("rejects a signature over the original message after compute instructions are added", async () => {
    const { client, rpc, wallet, sign } = fixture();
    const original = sign.getMockImplementation()!;
    sign.mockImplementation(async (transaction) => {
      const signed = await original(transaction);
      const message = TransactionMessage.decompile(signed.message);
      message.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1n }));
      signed.message = message.compileToV0Message();
      return signed;
    });
    expect(await client.createVault(wallet, params)).toEqual({ ok: false, origin: "client", error: "InvalidWalletSignature" });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it.each(["trailing bytes", "unsupported version"])("rejects %s in the wallet message", async (kind) => {
    const { client, rpc, wallet, sign } = fixture();
    sign.mockImplementation(async (transaction) => {
      const bytes = transaction.message.serialize();
      if (kind === "unsupported version") bytes[0] = 0x81;
      transaction.message.serialize = () => kind === "trailing bytes" ? new Uint8Array([...bytes, 0]) : bytes;
      return transaction;
    });
    expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, origin: "client", error: "WalletModifiedTransaction" });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it.each(["", "?debug=0", "?debug=1"])("logs only sanitized failures with opt-in debug: %s", async (search) => {
    vi.stubGlobal("window", { location: { search } });
    const log = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { client, wallet, sign } = fixture();
    const blob = "a".repeat(180);
    sign.mockRejectedValue(new Error(`Wallet unavailable at https://rpc.invalid/?token=hidden ${blob}`));
    const result = await client.createVault(wallet, params);
    expect(result).toEqual({ ok: false, origin: "client", error: "WalletSigningError", detail: "Wallet unavailable at [redacted data] [redacted data]" });
    if (search === "?debug=1") {
      expect(log).toHaveBeenCalledExactlyOnceWith("[Aegis wallet]", { step: "wallet.signTransaction", code: "WalletSigningError", reason: !result.ok && result.detail });
    } else expect(log).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(blob);
    expect(JSON.stringify(log.mock.calls)).not.toContain("token=hidden");
  });

  it.each(["getLatestBlockhash", "simulateTransaction", "sendTransaction", "getSignatureStatuses"])("never calls a 429 from %s SigningFailed", async (stage) => {
    const { client, rpc, wallet, sign } = fixture();
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method, params) => {
      if (method === stage) throw Object.assign(new Error("429 Too Many Requests: private provider context"), { status: 429 });
      return original(method, params);
    });
    expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, origin: "rpc", error: RPC_RATE_LIMITED });
    expect(RPC_RATE_LIMITED).toBe("RpcRateLimited");
    expect(sign).toHaveBeenCalledTimes(["getLatestBlockhash", "simulateTransaction"].includes(stage) ? 0 : 1);
  });

  it.each([
    { cause: { code: 429 } }, new Error("429 Too Many Requests"),
  ])("preserves a rate limit wrapped by the wallet adapter", async (error) => {
    const { client, rpc, wallet, sign } = fixture();
    sign.mockRejectedValue(error);
    expect(await client.createVault(wallet, params)).toEqual({ ok: false, origin: "rpc", error: RPC_RATE_LIMITED });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it.each([{ code: 4001 }, new Error("User rejected the request."), { cause: { code: 4001 } }, { error: { code: 4001 } }, new Error("User cancelled")])("identifies Phantom rejection separately from invalid signatures", async (error) => {
    const { client, rpc, wallet, sign } = fixture();
    sign.mockRejectedValue(error);
    expect(await client.createVault(wallet, params)).toEqual({ ok: false, origin: "client", error: WALLET_REJECTED });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it("rejects invalid amounts before contacting RPC or requesting a signature", async () => {
    const { client, rpc, wallet, sign } = fixture();
    expect(await client.createVault(wallet, { ...params, budgetRaw: -1n })).toMatchObject({ ok: false, error: "InvalidAmount" });
    expect(rpc).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  });

  it.each(["AccountNotFound", "InsufficientFundsForFee", "InsufficientFundsForRent", { InsufficientFundsForRent: { account_index: 0 } }])("does not request a wallet signature when fee/rent simulation fails: %j", async (err) => {
    const { client, rpc, wallet, sign } = fixture();
    rpc.mockResolvedValueOnce({ value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 } })
      .mockResolvedValueOnce({ value: { err } });
    expect(await client.createVault(wallet, params)).toEqual({ ok: false, origin: "program", error: "NoDevnetSol" });
    expect(sign).not.toHaveBeenCalled();
  });
});

it.each(["simulateTransaction", "getSignatureStatuses"])("logs sanitized program failures at %s", async (stage) => {
  vi.stubGlobal("window", { location: { search: "?debug=1" } });
  const log = vi.spyOn(console, "debug").mockImplementation(() => {});
  const { client, rpc, wallet, sign } = fixture();
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method, args) => {
    if (method === stage) {
      const status = { err: { InstructionError: [0, "InsufficientFunds"] }, confirmationStatus: "confirmed" };
      return { value: stage === "simulateTransaction" ? status : [status] };
    }
    if (method === "getTransaction") return null;
    return original(method, args);
  });
  expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, origin: "program", error: "InsufficientFunds" });
  expect(log).toHaveBeenCalledExactlyOnceWith("[Aegis wallet]", {
    step: stage, code: stage === "simulateTransaction" ? "SimulationFailed" : "TransactionFailed", reason: "InsufficientFunds",
  });
  if (stage === "simulateTransaction") expect(sign).not.toHaveBeenCalled();
});

it("preserves the locally computed signature when submission is uncertain", async () => {
  const { client, rpc, wallet } = fixture();
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method, params) => {
    if (method === "sendTransaction") throw new Error("private RPC context");
    return original(method, params);
  });
  expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, origin: "rpc", error: "RpcError", signature: expect.any(String) });
});

it.each([
  { data: { err: "AccountNotFound" } },
  { data: { err: "InsufficientFundsForFee" } },
  { data: { err: { InsufficientFundsForRent: { account_index: 0 } } } },
  new Error("Transaction simulation failed: insufficient lamports for rent"),
])("returns NoDevnetSol if funds run out between simulation and send: %j", async (error) => {
  const { client, rpc, wallet, sign } = fixture();
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method, params) => {
    if (method === "sendTransaction") throw error;
    return original(method, params);
  });
  expect(await client.createVault(wallet, params)).toMatchObject({ ok: false, error: "NoDevnetSol", signature: expect.any(String) });
  expect(sign).toHaveBeenCalledTimes(1);
});
