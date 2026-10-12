import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { ClientError, isTransientRpcError, ProgramError, RpcError } from "../src/errors";
import { sendSignedTransaction, type SignedTransactionRpc, type TransactionStatus } from "../src/transaction-retry";
import { fixture } from "./anchor-helpers";
import { walletSvm } from "./wallet-svm";

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const landed = { err: null, confirmationStatus: "confirmed" };
const missing = new RpcError("BlockhashNotFound");
function transport() {
  return {
    send: vi.fn(async () => "signature"),
    status: vi.fn<() => Promise<TransactionStatus>>().mockResolvedValue(landed),
    height: vi.fn(async (_commitment: "confirmed" | "finalized") => 10),
  } satisfies SignedTransactionRpc;
}
async function finish<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

it.each([
  { status: 429 }, { status: 500 }, { status: 502 }, { status: 503 }, { status: 504 },
  { code: -32005 }, { error: { data: { err: "BlockhashNotFound" } } },
  new Error("Blockhash not found"), new Error("block height exceeded"), new Error("Node is behind"),
  new TypeError("Failed to fetch"), new Error("network timeout"), { cause: { code: "ECONNRESET" } },
  new RpcError("RpcRateLimited"), new Error("TransactionExpiredBlockheightExceededError"),
])("classifies transient infrastructure failure: %s", (error) => expect(isTransientRpcError(error)).toBe(true));

it.each([
  new ProgramError("CapExceeded"), new ProgramError("BudgetExceeded"), new ClientError("InvalidAmount"),
  { code: 4001 }, { status: 400 }, { status: 401 }, { status: 403 },
  { code: -32002, data: { err: { InstructionError: [0, { Custom: 6004 }] } } },
])("does not retry a deterministic rejection: %s", (error) => expect(isTransientRpcError(error)).toBe(false));

it("resends after a preflight blockhash miss while valid, with backoff and progress", async () => {
  const rpc = transport(), progress = vi.fn();
  rpc.send.mockRejectedValueOnce(missing);
  rpc.status.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  const pending = sendSignedTransaction(rpc, 100, { onRetry: progress });
  await vi.advanceTimersByTimeAsync(524);
  expect(rpc.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await finish(pending)).toEqual({ err: null });
  expect(rpc.send).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenCalled();
  expect(rpc.height).toHaveBeenCalledWith("confirmed");
});

it.each([new Error("network timeout"), missing, new Error("already processed")])("recognizes a landed signature after a failed send: %s", async (error) => {
  const rpc = transport(); rpc.send.mockRejectedValue(error);
  expect(await finish(sendSignedTransaction(rpc, 100))).toEqual({ err: null });
  expect(rpc.send).toHaveBeenCalledTimes(1);
});

it("polls statuses when confirmation hangs, and closes the websocket subscription", async () => {
  const rpc = { ...transport(), confirm: vi.fn((_signal: AbortSignal) => new Promise<{ err: unknown }>(() => {})) };
  expect(await finish(sendSignedTransaction(rpc, 100))).toEqual({ err: null });
  expect(rpc.confirm.mock.calls[0][0].aborted).toBe(true);
  expect(rpc.send).toHaveBeenCalledTimes(1);
});

it("recovers from status rate limits without treating them as a program rejection", async () => {
  const rpc = transport();
  rpc.status.mockRejectedValueOnce(new RpcError("RpcRateLimited"));
  expect(await finish(sendSignedTransaction(rpc, 100))).toEqual({ err: null });
  expect(rpc.send).toHaveBeenCalledTimes(1);
});

it("waits for a processed signature to become confirmed without sending again", async () => {
  const rpc = transport();
  rpc.status.mockResolvedValueOnce({ err: null, confirmationStatus: "processed", confirmations: null });
  expect(await finish(sendSignedTransaction(rpc, 100))).toEqual({ err: null });
  expect(rpc.send).toHaveBeenCalledTimes(1);
  expect(rpc.status).toHaveBeenCalledTimes(2);
});

it("does not rebuild after apparent expiry when signature history is unavailable", async () => {
  const f = await fixture();
  f.sendRawTransaction.mockRejectedValue(new Error("network timeout"));
  vi.spyOn(f.connection, "getSignatureStatuses")
    .mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
    .mockRejectedValue(new RpcError("RpcRateLimited"));
  vi.spyOn(f.connection, "getBlockHeight").mockResolvedValue(1000);
  expect(await finish(f.client.fundVault(f.owner, f.vault, 1_000_000_000n)))
    .toMatchObject({ ok: false, error: "ConfirmationTimedOut", signature: expect.any(String) });
  expect(f.getLatestBlockhash).toHaveBeenCalledTimes(1);
});

it("checks history again after finalized expiry, accepting a late confirmation", async () => {
  const rpc = transport();
  rpc.height.mockResolvedValue(101);
  rpc.status.mockResolvedValueOnce(null).mockResolvedValueOnce(landed);
  expect(await finish(sendSignedTransaction(rpc, 100))).toEqual({ err: null });
  expect(rpc.height.mock.calls).toEqual([["confirmed"], ["finalized"]]);
  expect(rpc.send).toHaveBeenCalledTimes(1);
});

it("keeps a confirmed program rejection authoritative", async () => {
  const rpc = transport(), err = { InstructionError: [0, { Custom: 6004 }] };
  rpc.status.mockResolvedValue({ ...landed, err });
  expect(await finish(sendSignedTransaction(rpc, 100))).toEqual({ err });
  expect(rpc.send).toHaveBeenCalledTimes(1);
});

it("never re-signs an uncertain server payment while its blockhash is valid", async () => {
  const f = await fixture();
  f.sendRawTransaction.mockRejectedValue(new Error("network timeout"));
  vi.spyOn(f.connection, "getSignatureStatuses").mockResolvedValue({ context: { slot: 1 }, value: [null] });
  vi.spyOn(f.connection, "getBlockHeight").mockResolvedValue(10);
  expect(await finish(f.client.fundVault(f.owner, f.vault, 1_000_000_000n)))
    .toMatchObject({ ok: false, origin: "rpc", error: "ConfirmationTimedOut", signature: expect.any(String) });
  expect(f.getLatestBlockhash).toHaveBeenCalledTimes(1);
  expect(f.sendRawTransaction).toHaveBeenCalledTimes(4);
  const bytes = f.sendRawTransaction.mock.calls.map(([bytes]) => Buffer.from(bytes));
  expect(bytes.every((value) => value.equals(bytes[0]))).toBe(true);
});

it("rebuilds a server payment only after finalized expiry and an absent signature", async () => {
  const f = await fixture();
  f.sendRawTransaction.mockRejectedValueOnce(missing);
  const fresh = { blockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(), lastValidBlockHeight: 1200 };
  f.getLatestBlockhash.mockResolvedValueOnce(f.lifetime).mockResolvedValue(fresh);
  vi.spyOn(f.connection, "getSignatureStatuses").mockResolvedValue({ context: { slot: 1 }, value: [null] });
  vi.spyOn(f.connection, "getBlockHeight").mockResolvedValue(1000);
  expect(await finish(f.client.fundVault(f.owner, f.vault, 1_000_000_000n))).toMatchObject({ ok: true });
  expect(f.getLatestBlockhash).toHaveBeenCalledTimes(2);
  expect(f.sent[0].recentBlockhash).toBe(fresh.blockhash);
  expect(f.sent[0].instructions[0].data.readBigUInt64LE(1)).toBe(1_000_000_000n);
});

it("reports true wallet expiry without a second signature request", async () => {
  const f = walletSvm(), original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, params) => {
    if (method === "sendTransaction") throw missing;
    if (method === "getSignatureStatuses") return { value: [null] };
    if (method === "getBlockHeight") return 1000;
    return original(method, params);
  });
  expect(await finish(f.client.createVault(f.wallet, f.params))).toMatchObject({ ok: false, error: "TransactionExpired" });
  expect(f.sign).toHaveBeenCalledTimes(1);
});

it("retries transient simulation failures before asking the wallet to sign", async () => {
  const f = walletSvm(), original = f.rpc.getMockImplementation()!;
  let failures = 2;
  f.rpc.mockImplementation(async (method, params) => {
    if (method === "simulateTransaction" && failures-- > 0) return { value: { err: "BlockhashNotFound", logs: [] } };
    return original(method, params);
  });
  expect(await finish(f.client.createVault(f.wallet, f.params))).toMatchObject({ ok: true });
  expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.rpc.mock.calls.filter(([method]) => method === "simulateTransaction")).toHaveLength(3);
});
