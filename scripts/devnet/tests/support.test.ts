import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupProgramKey, fundingBudget, inspectProgram, loadOrCreateKey, readRpc, runFundedDeployment } from "../support";

const temporary: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  // Even temporary test key files live under the ignored .keys directory.
  await mkdir(".keys", { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(".keys/devnet-unit-"));
  temporary.push(root);
  return root;
}

describe("funding gate", () => {
  it("stops before any deploy or seed work when one lamport short", async () => {
    const deploy = vi.fn();
    const budget = fundingBudget(2_285_075_440n, 9_463_360n, 0n);
    await expect(runFundedDeployment(budget.required - 1n, budget.required, false, deploy))
      .rejects.toThrow("add 0.000000001 SOL. No transactions sent.");
    expect(deploy).not.toHaveBeenCalled();
  });
  it("keeps --check read-only even when funded", async () => {
    const deploy = vi.fn();
    await runFundedDeployment(10_000_000_000n, 3_000_000_000n, true, deploy);
    expect(deploy).not.toHaveBeenCalled();
  });
  it("runs deployment at the exact required balance", async () => {
    const deploy = vi.fn().mockResolvedValue(undefined);
    await runFundedDeployment(3_000_000_000n, 3_000_000_000n, false, deploy);
    expect(deploy).toHaveBeenCalledOnce();
  });
  it("uses exact bigint arithmetic, counts buffer reserves and tops up only missing agent fees", () => {
    const large = 9_007_199_254_740_993n;
    expect(fundingBudget(large, 2n, 60_000_000n, 3n))
      .toEqual({ programRent: large, setupRent: 2n, uploadBuffer: 3n, agentFunding: 0n, fees: 50_000_000n, required: large + 50_000_005n });
    expect(fundingBudget(0n, 0n, 20_000_000n).agentFunding).toBe(30_000_000n);
  });
});

describe("deployment identities", () => {
  it("reuses a key and preserves restrictive permissions", async () => {
    const root = await fixture();
    const first = await loadOrCreateKey(root, "devnet-agent");
    const second = await loadOrCreateKey(root, "devnet-agent", first.publicKey.toBase58());
    expect(second.publicKey.equals(first.publicKey)).toBe(true);
    expect((await stat(resolve(root, ".keys/devnet-agent.json"))).mode & 0o777).toBe(0o600);
  });
  it("never silently replaces a lost or mismatched existing deployment key", async () => {
    const root = await fixture();
    const expected = Keypair.generate().publicKey.toBase58();
    await expect(loadOrCreateKey(root, "devnet-agent", expected)).rejects.toThrow("restore it from backup");
    await loadOrCreateKey(root, "devnet-agent");
    await expect(loadOrCreateKey(root, "devnet-agent", expected)).rejects.toThrow("does not match");
  });
  it("redacts corrupt key contents", async () => {
    const root = await fixture();
    await mkdir(resolve(root, ".keys"));
    await writeFile(resolve(root, ".keys/devnet-agent.json"), "private-file-content");
    await expect(loadOrCreateKey(root, "devnet-agent")).rejects.toThrow("contents withheld");
  });
  it("backs up the original program identity and can recover it after target is deleted", async () => {
    const root = await fixture();
    // The fixture's target also remains underneath the repository's ignored .keys/.
    await mkdir(resolve(root, "target/deploy"), { recursive: true });
    const original = Keypair.generate();
    await writeFile(resolve(root, "target/deploy/aegis-keypair.json"), JSON.stringify(Array.from(original.secretKey)), { mode: 0o600 });
    await backupProgramKey(root, "aegis", original.publicKey.toBase58());
    await rm(resolve(root, "target"), { recursive: true });
    const restored = await backupProgramKey(root, "aegis", original.publicKey.toBase58());
    expect(restored.publicKey.equals(original.publicKey)).toBe(true);
    const before = await readFile(resolve(root, ".keys/programs/aegis-keypair.json"));
    await expect(backupProgramKey(root, "aegis", Keypair.generate().publicKey.toBase58())).rejects.toThrow("does not match");
    expect((await readFile(resolve(root, ".keys/programs/aegis-keypair.json"))).equals(before)).toBe(true);
  });
});

describe("existing program verification", () => {
  function programFixture() {
    const connection = new Connection("http://127.0.0.1:8899");
    const id = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const programData = Keypair.generate().publicKey;
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    const header = Buffer.alloc(36);
    header.writeUInt32LE(2);
    programData.toBuffer().copy(header, 4);
    const data = Buffer.alloc(45 + binary.length + 8);
    data.writeUInt32LE(3);
    data[12] = 1;
    authority.toBuffer().copy(data, 13);
    binary.copy(data, 45);
    const info = { executable: true, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), lamports: 0, rentEpoch: 0 };
    const read = vi.spyOn(connection, "getAccountInfo").mockResolvedValueOnce({ ...info, data: header })
      .mockResolvedValue({ ...info, executable: false, data });
    return { connection, id, authority, programData, binary, data, read, info };
  }
  it("skips identical code, including zero padding", async () => {
    const f = programFixture();
    expect(await inspectProgram(f.connection, f.id, f.binary, f.authority)).toEqual({ exists: true, current: true, dataAddress: f.programData });
  });
  it("detects missing and changed programs", async () => {
    const f = programFixture();
    f.read.mockReset().mockResolvedValue(null);
    expect(await inspectProgram(f.connection, f.id, f.binary, f.authority)).toEqual({ exists: false, current: false });
    const changed = programFixture();
    changed.data[45] = 0;
    expect(await inspectProgram(changed.connection, changed.id, changed.binary, changed.authority)).toEqual({ exists: true, current: false, dataAddress: changed.programData });
  });
  it.each(["immutable", "wrong-authority", "truncated", "wrong-loader"])("refuses %s program data", async (kind) => {
    const f = programFixture();
    if (kind === "immutable") f.data[12] = 0;
    if (kind === "wrong-authority") f.authority = Keypair.generate().publicKey;
    if (kind === "truncated") f.read.mockResolvedValue({ ...f.info, data: Buffer.alloc(12) });
    if (kind === "wrong-loader") f.read.mockResolvedValue({ ...f.info, owner: PublicKey.default, data: f.data });
    await expect(inspectProgram(f.connection, f.id, f.binary, f.authority)).rejects.toThrow("upgrade authority");
  });
});

describe("read-only deployment RPC retries", () => {
  it("preserves bigint amounts and supplies an abort deadline on each attempt", async () => {
    vi.useFakeTimers();
    const amount = 9_007_199_254_740_993n;
    const read = vi.fn<(signal: AbortSignal) => Promise<bigint>>().mockRejectedValueOnce(new Error("temporary RPC error")).mockResolvedValue(amount);
    const pending = readRpc(read);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(amount);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  });
  it("stops after four failures and returns a controlled error", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("sensitive transport context"));
    const check = expect(readRpc(read)).rejects.toThrow("Devnet RPC unavailable after retries");
    await vi.runAllTimersAsync();
    await check;
    expect(read).toHaveBeenCalledTimes(4);
  });
});
