import { ComputeBudgetProgram, MessageV0, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateWalletMessage } from "../src/wallet-validation";
import { debugWalletFailure, walletErrorDetail } from "../src/wallet-diagnostics";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const payer = key(1), program = key(2), account = key(3);
const instructions: TransactionInstruction[] = [1, 2].map((byte) => ({
  programId: program, keys: [{ pubkey: account, isWritable: true, isSigner: false }], data: Buffer.from([byte]),
}));
const compile = (items: TransactionInstruction[]) => MessageV0.compile({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: items });
const expected = compile(instructions);
const limit = (units = 1_400_000) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const price = (microLamports = 1_000_000n) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

describe("wallet message safety", () => {
  it("accepts compute instructions between original instructions", () => {
    expect(() => validateWalletMessage(expected, compile([instructions[0], limit(), instructions[1], price()]))).not.toThrow();
  });

  it.each([
    ["zero price", price(0n)], ["minimum limit", limit(1)],
  ])("accepts %s", (_, instruction) => {
    expect(() => validateWalletMessage(expected, compile([instruction, ...instructions]))).not.toThrow();
  });

  it.each([
    ["changed data", [{ ...instructions[0], data: Buffer.from([9]) }, instructions[1]]],
    ["removed instruction", instructions.slice(1)],
    ["reordered instructions", [...instructions].reverse()],
    ["duplicate instruction", [...instructions, instructions[0]]],
    ["unknown program", [...instructions, { programId: key(4), keys: [], data: Buffer.alloc(0) }]],
    ["zero limit", [limit(0), ...instructions]],
    ["excess limit", [limit(1_400_001), ...instructions]],
    ["excess price", [price(1_000_001n), ...instructions]],
    ["u64 maximum price", [price((1n << 64n) - 1n), ...instructions]],
    ["duplicate limit", [limit(), ...instructions, limit()]],
    ["duplicate price", [price(), ...instructions, price()]],
    ["heap instruction", [ComputeBudgetProgram.requestHeapFrame({ bytes: 32_768 }), ...instructions]],
    ["unknown compute opcode", [{ ...limit(), data: Buffer.from([99]) }, ...instructions]],
    ["truncated compute data", [{ ...limit(), data: Buffer.from([2]) }, ...instructions]],
    ["trailing compute data", [{ ...price(), data: Buffer.concat([price().data, Buffer.from([0])]) }, ...instructions]],
    ["compute account metas", [{ ...limit(), keys: instructions[0].keys }, ...instructions]],
  ] satisfies [string, TransactionInstruction[]][])("rejects %s", (_, modified) => {
    expect(() => validateWalletMessage(expected, compile(modified))).toThrow("WalletModifiedTransaction");
  });

  it.each(["writability", "signer", "payer", "blockhash", "lookup table", "duplicate account", "invalid index"])("rejects changed %s", (kind) => {
    const actual = compile(instructions);
    if (kind === "writability") actual.header.numReadonlyUnsignedAccounts++;
    if (kind === "signer") actual.header.numRequiredSignatures++;
    if (kind === "payer") actual.staticAccountKeys[0] = key(4);
    if (kind === "blockhash") actual.recentBlockhash = key(4).toBase58();
    if (kind === "lookup table") actual.addressTableLookups.push({ accountKey: key(4), writableIndexes: [], readonlyIndexes: [0] });
    if (kind === "duplicate account") actual.staticAccountKeys.push(actual.staticAccountKeys[0]);
    if (kind === "invalid index") actual.compiledInstructions[0].accountKeyIndexes[0] = 255;
    expect(() => validateWalletMessage(expected, actual)).toThrow("WalletModifiedTransaction");
  });

  it("allows account index rearrangement without changing addresses or permissions", () => {
    const actual = compile([limit(), ...instructions]);
    const last = actual.staticAccountKeys.length - 1, previous = last - 1;
    [actual.staticAccountKeys[last], actual.staticAccountKeys[previous]] = [actual.staticAccountKeys[previous], actual.staticAccountKeys[last]];
    for (const instruction of actual.compiledInstructions) {
      instruction.programIdIndex = instruction.programIdIndex === last ? previous : instruction.programIdIndex === previous ? last : instruction.programIdIndex;
    }
    expect(() => validateWalletMessage(expected, actual)).not.toThrow();
  });
});

it("extracts bounded wallet prose and redacts wire data and sensitive fields", () => {
  expect(walletErrorDetail({ cause: new Error("Wallet locked") })).toBe("Wallet locked");
  expect(walletErrorDetail(new Error("Failure: transaction=" + "a".repeat(200)))).toBe("Failure: [redacted data]");
  expect(walletErrorDetail(new Error('Failure {"bytes":[1,2,3]}'))).toBe("Failure [redacted data]");
  expect(walletErrorDetail(new Error("Error: private key=placeholder"))).toBe("Error: [redacted data]");
  expect(walletErrorDetail(new Error("Error: api_key=placeholder"))).toBe("Error: [redacted data]");
  expect(walletErrorDetail(new Error("Transport wss://rpc.invalid/?token=placeholder"))).toBe("Transport [redacted data]");
  expect(walletErrorDetail(new Error("x ".repeat(300))).length).toBeLessThanOrEqual(240);
  expect(walletErrorDetail({})).toBe("No wallet error message was provided.");
});

it("sanitizes diagnostic codes and reasons at the logging boundary", () => {
  vi.stubGlobal("window", { location: { search: "?debug=1" } });
  const log = vi.spyOn(console, "debug").mockImplementation(() => {});
  debugWalletFailure("sendTransaction", "a".repeat(180), "RPC failed: payload=[1,2,3]");
  expect(log).toHaveBeenCalledExactlyOnceWith("[Aegis wallet]", {
    step: "sendTransaction", code: "TransactionFailed", reason: "RPC failed: [redacted data]",
  });
});
