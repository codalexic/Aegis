import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { WalletAegisClient, type WalletSigner } from "../../../packages/sdk/src/wallet";
import { encode as encodeSignature } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { WalletTransaction } from "../../../packages/sdk/src/wallet-transaction";
import deployment from "../../../deployments/localnet.json";
import { DEVNET_RPC_URL, DEVNET_WS_URL } from "../../../packages/sdk/src/devnet";

afterEach(() => vi.restoreAllMocks());
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

  it.each(["declined", "unsigned", "changed message", "wrong signer"])("does not submit when signing is %s", async (kind) => {
    const { client, rpc, wallet, sign } = fixture();
    sign.mockImplementation(async (transaction) => {
      if (kind === "declined") throw new Error("private extension context");
      if (kind === "changed message") transaction.message.recentBlockhash = owner.publicKey.toBase58();
      if (kind === "wrong signer") {
        const key = Keypair.generate();
        const other = VersionedTransaction.deserialize(transaction.serialize());
        other.message.staticAccountKeys[0] = key.publicKey; other.sign([key]);
        transaction.signatures[0] = other.signatures[0];
      }
      return transaction;
    });
    expect(await client.createVault(wallet, params)).toEqual({ ok: false, origin: "client", error: "SigningFailed" });
    expect(rpc.mock.calls.some(([method]) => method === "sendTransaction")).toBe(false);
  });

  it("rejects invalid amounts before contacting RPC or requesting a signature", async () => {
    const { client, rpc, wallet, sign } = fixture();
    expect(await client.createVault(wallet, { ...params, budgetRaw: -1n })).toMatchObject({ ok: false, error: "InvalidAmount" });
    expect(rpc).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  });

  it("does not request a wallet signature when simulation fails", async () => {
    const { client, rpc, wallet, sign } = fixture();
    rpc.mockResolvedValueOnce({ value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 } })
      .mockResolvedValueOnce({ value: { err: "InsufficientFundsForRent" } });
    expect(await client.createVault(wallet, params)).toEqual({ ok: false, origin: "program", error: "InsufficientFundsForRent" });
    expect(sign).not.toHaveBeenCalled();
  });
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
