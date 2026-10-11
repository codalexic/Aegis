import { afterEach, expect, it, vi } from "vitest";
import { createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { Transaction } from "@solana/web3.js";
import { assertSuccess, FUNDING, send, tokenAccount } from "../../../tests/program/helpers";
import { programErrorName } from "../src/errors";
import { walletSvm } from "./wallet-svm";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function assertEmptyTransfer(f: ReturnType<typeof walletSvm>) {
  // Bypass the new client check to retain proof of the original runtime failure.
  const result = send(f.svm, [createTransferCheckedInstruction(f.ownerInput, f.inputMint, f.inputVault, f.owner.publicKey, FUNDING, 6)], [f.owner]);
  expect(result).toBeInstanceOf(FailedTransactionMetadata);
  const logs = (result as FailedTransactionMetadata).meta().logs();
  expect(logs).toContain(`Program ${TOKEN_PROGRAM_ID} failed: custom program error: 0x1`);
  expect(programErrorName(logs)).toBe("InsufficientFunds");
}

it("reproduces create -> fund -> fund again with SPL Token custom 1", async () => {
  const f = walletSvm();
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toMatchObject({ ok: true });
  expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(0n);
  assertEmptyTransfer(f);
  f.rpc.mockClear();
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toMatchObject({ ok: false, error: "InsufficientFunds", origin: "client" });
  expect(f.rpc.mock.calls.map(([method]) => method)).not.toContain("simulateTransaction");
  expect(f.rpc.mock.calls.map(([method]) => method)).not.toContain("sendTransaction");
  expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING);
  expect(f.sign).toHaveBeenCalledTimes(2);
});

it("reproduces funding an empty wallet with SPL Token custom 1", async () => {
  const f = walletSvm(0n);
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
  assertEmptyTransfer(f);
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toMatchObject({ ok: false, error: "InsufficientFunds", origin: "client" });
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it("reproduces an explicitly reused vault ID with System custom 0, while a fresh ID succeeds", async () => {
  const f = walletSvm();
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: false, error: "AccountAlreadyInUse" });
  expect(f.logs.at(-1)).toContain("Program 11111111111111111111111111111111 failed: custom program error: 0x0");
  expect(await f.client.createVault(f.wallet, { ...f.params, vaultId: 1n })).toMatchObject({ ok: true });
});

it("reproduces create without enough SOL for rent with System custom 1", async () => {
  const f = walletSvm();
  const account = f.svm.getAccount(address(f.owner.publicKey.toBase58()));
  if (!account.exists) throw new Error("Missing owner");
  f.svm.setAccount({ ...account, lamports: lamports(1_000_000n) });
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: false, error: "ResultWithNegativeLamports" });
  expect(f.logs.at(-1)).toContain("Program 11111111111111111111111111111111 failed: custom program error: 0x1");
});

it("treats a missing wallet ATA as empty without signing or simulating funding", async () => {
  const f = walletSvm(0n, false);
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
  f.rpc.mockClear();
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toEqual({ ok: false, error: "InsufficientFunds", origin: "client" });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.rpc.mock.calls.map(([method]) => method)).not.toContain("simulateTransaction");
});

it("reads the balance again after withdraw so funding can resume", async () => {
  const f = walletSvm();
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toMatchObject({ ok: true });
  expect(await f.client.withdraw(f.wallet, f.vault, f.inputMint, FUNDING)).toMatchObject({ ok: true });
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toMatchObject({ ok: true });
  expect(tokenAccount(f.svm, f.ownerInput).amount).toBe(0n);
  expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING);
});

it("keeps SPL custom 1 from send preflight if funds move while Phantom is open", async () => {
  const f = walletSvm();
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
  // Exercise the real JSON-RPC error handling, backed by LiteSVM execution.
  vi.mocked(f.client.rpc).mockRestore();
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const { method, params } = JSON.parse(init.body as string);
    if (method !== "sendTransaction") return Response.json({ result: await f.rpc(method, params) });
    const result = f.svm.simulateTransaction(getTransactionDecoder().decode(Buffer.from(params[0], "base64")));
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    const logs = result.meta().logs();
    expect(logs).toContain(`Program ${TOKEN_PROGRAM_ID} failed: custom program error: 0x1`);
    return Response.json({ error: { code: -32002, message: "Untrusted RPC details",
      data: { err: { InstructionError: [0, { Custom: 1 }] }, logs } } });
  }));
  const sign = f.sign.getMockImplementation()!;
  f.sign.mockImplementation(async (transaction) => {
    const drain = new Transaction({ feePayer: f.owner.publicKey, recentBlockhash: f.svm.latestBlockhash() })
      .add(createTransferCheckedInstruction(f.ownerInput, f.inputMint, f.inputVault, f.owner.publicKey, FUNDING, 6));
    drain.sign(f.owner);
    // Keep the original wallet transaction's blockhash valid while its funds move.
    assertSuccess(f.svm.sendTransaction(getTransactionDecoder().decode(drain.serialize())));
    return sign(transaction);
  });
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toMatchObject({ ok: false, error: "InsufficientFunds", origin: "program", signature: expect.any(String) });
  expect(tokenAccount(f.svm, f.inputVault).amount).toBe(FUNDING);
});

it("does not simulate or sign funding when the fresh wallet read fails", async () => {
  const f = walletSvm();
  expect(await f.client.createVault(f.wallet, f.params)).toMatchObject({ ok: true });
  const rpc = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, params) => {
    if (method === "getAccountInfo" && params[0] === f.ownerInput.toBase58()) throw new Error("RPC unavailable");
    return rpc(method, params);
  });
  f.rpc.mockClear();
  expect(await f.client.fundVault(f.wallet, f.vault, FUNDING)).toMatchObject({ ok: false, error: "RpcError" });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.rpc.mock.calls.map(([method]) => method)).not.toContain("simulateTransaction");
});
