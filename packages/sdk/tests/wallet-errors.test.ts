import { afterEach, expect, it, vi } from "vitest";
import { isNoDevnetSol, walletTransactionErrorName } from "../src/wallet-errors";
import { WalletAegisClient } from "../src/wallet";
import { ChainReader } from "../src/chain-reader";
import deployment from "../../../deployments/devnet.json";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const failures = [
  "AccountNotFound", "InsufficientFundsForFee", "InsufficientFundsForRent",
  { InsufficientFundsForRent: { account_index: 0 } },
  new Error("Transaction simulation failed: insufficient lamports for fee"),
  { cause: { message: "insufficient lamports for rent" } },
  { error: { data: { err: "AccountNotFound" } } },
  { message: "Transaction results in an account (0) with insufficient funds for rent" },
];
it.each(failures)("maps wallet fee/rent errors to NoDevnetSol: %j", (error) => {
  expect(walletTransactionErrorName(error)).toBe("NoDevnetSol");
});
it("keeps token shortages and unrelated failures separate", () => {
  expect(isNoDevnetSol("InsufficientFunds")).toBe(false);
  expect(walletTransactionErrorName({ InstructionError: [0, "InvalidArgument"] })).toBe("InvalidArgument");
});
it("recognizes lamport failures in simulation logs", () => {
  expect(walletTransactionErrorName({ InstructionError: [0, { Custom: 1 }] }, [
    "Program log: Transfer: insufficient lamports 0, need 2039280",
  ])).toBe("NoDevnetSol");
});
it.each(failures)("preserves the named error from real send RPC parsing: %j", async (error) => {
  // JSON serializes Error messages only when explicitly supplied by the RPC.
  const wire = error instanceof Error ? { message: error.message } : typeof error === "string" ? { data: { err: error } } : error;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: wire })));
  await expect(new WalletAegisClient(deployment).rpc("sendTransaction", ["unsigned-test-placeholder"]))
    .rejects.toThrow("NoDevnetSol");
});
it("leaves the shared reader error behavior unchanged", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { data: { err: "AccountNotFound" } } })));
  await expect(new ChainReader(deployment).rpc("sendTransaction", [])).rejects.toThrow("RpcError");
});
