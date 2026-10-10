import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMint } from "@solana/spl-token";
import { sendAndConfirmTransaction } from "@solana/web3.js";
import { environmentSigner, checkFaucetHistory, devnetClient, mintTestUsdc, deployment } from "../server/devnet-service";
import { IpLimiter } from "../server/public-limits";
import { readBody } from "../server/http";

vi.mock("@solana/web3.js", async (original) => ({ ...await original<object>(), sendAndConfirmTransaction: vi.fn() }));
vi.mock("@solana/spl-token", async (original) => ({ ...await original<object>(), getMint: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("environment-only signing configuration", () => {
  it("accepts a JSON keypair only when its public key matches and never exposes invalid values", () => {
    const key = Keypair.generate();
    const value = JSON.stringify(Array.from(key.secretKey));
    expect(environmentSigner({ AEGIS_AGENT_SECRET: value }, "AEGIS_AGENT_SECRET", key.publicKey.toBase58()).publicKey.equals(key.publicKey)).toBe(true);
    for (const invalid of [undefined, "private-malformed-value", "[]", JSON.stringify(Array(64).fill(256)), value]) {
      expect(() => environmentSigner({ AEGIS_AGENT_SECRET: invalid }, "AEGIS_AGENT_SECRET", PublicKey.default.toBase58())).toThrow("AEGIS_AGENT_SECRET is missing or does not match");
    }
  });
  it("uses the committed devnet RPC regardless of local environment variables", () => {
    vi.stubEnv("AEGIS_ENV", "localnet");
    try { expect(devnetClient().connection.rpcEndpoint).toBe("https://api.devnet.solana.com"); }
    finally { vi.unstubAllEnvs(); }
  });
});

describe("faucet transaction", () => {
  it("mints exactly 1,000 testUSDC to the requested wallet ATA using only the configured authority", async () => {
    const authority = { publicKey: new PublicKey(deployment.faucet) } as Keypair;
    vi.spyOn(Keypair, "fromSecretKey").mockReturnValue(authority);
    vi.mocked(getMint).mockResolvedValue({ decimals: 6, mintAuthority: authority.publicKey } as Awaited<ReturnType<typeof getMint>>);
    const client = devnetClient();
    vi.spyOn(Object.getPrototypeOf(client.connection), "getSignaturesForAddress").mockResolvedValue([]);
    vi.mocked(sendAndConfirmTransaction).mockResolvedValue("test-only-signature");
    const recipient = Keypair.generate().publicKey;
    const result = await mintTestUsdc({ AEGIS_FAUCET_SECRET: JSON.stringify(Array(64).fill(1)) }, recipient);
    expect(result).toEqual({ signature: "test-only-signature", amountRaw: "1000000000" });
    const [, transaction, signers] = vi.mocked(sendAndConfirmTransaction).mock.calls[0];
    expect(signers).toEqual([authority]);
    expect(authority.publicKey.toBase58()).not.toBe(deployment.owner);
    expect(transaction.instructions).toHaveLength(2);
    expect(transaction.instructions[0].keys[0].pubkey.equals(authority.publicKey)).toBe(true);
    expect(transaction.instructions[0].keys[2].pubkey.equals(recipient)).toBe(true);
    const mint = transaction.instructions[1];
    expect(mint.data[0]).toBe(14); // SPL MintToChecked
    expect(mint.data.readBigUInt64LE(1)).toBe(1_000_000_000n);
    expect(mint.data[9]).toBe(6);
    expect(mint.keys[0].pubkey.toBase58()).toBe(deployment.inputMint);
    expect(mint.keys[2].pubkey.equals(authority.publicKey)).toBe(true);
  });
  it.each([
    { decimals: 9, mintAuthority: new PublicKey(deployment.faucet) },
    { decimals: 6, mintAuthority: new PublicKey(deployment.owner) },
    { decimals: 6, mintAuthority: Keypair.generate().publicKey },
    { decimals: 6, mintAuthority: null },
  ])("does not send when mint configuration differs: %j", async (state) => {
    vi.spyOn(Keypair, "fromSecretKey").mockReturnValue({ publicKey: new PublicKey(deployment.faucet) } as Keypair);
    vi.mocked(getMint).mockResolvedValue(state as Awaited<ReturnType<typeof getMint>>);
    await expect(mintTestUsdc({ AEGIS_FAUCET_SECRET: JSON.stringify(Array(64).fill(1)) }, Keypair.generate().publicKey)).rejects.toThrow("mint configuration mismatch");
    expect(sendAndConfirmTransaction).not.toHaveBeenCalled();
  });
  it.each([deployment.owner, Keypair.generate().publicKey.toBase58()])("rejects a secret for %s before RPC or sending", async (publicKey) => {
    vi.spyOn(Keypair, "fromSecretKey").mockReturnValue({ publicKey: new PublicKey(publicKey) } as Keypair);
    await expect(mintTestUsdc({ AEGIS_FAUCET_SECRET: JSON.stringify(Array(64).fill(1)) }, Keypair.generate().publicKey)).rejects.toThrow("AEGIS_FAUCET_SECRET is missing or does not match");
    expect(getMint).not.toHaveBeenCalled();
    expect(sendAndConfirmTransaction).not.toHaveBeenCalled();
  });
  it.each([undefined, deployment.owner])("rejects a missing or deployer faucet in the manifest", async (faucet) => {
    const original = deployment.faucet;
    try {
      deployment.faucet = faucet as string;
      await expect(mintTestUsdc({}, Keypair.generate().publicKey)).rejects.toThrow("dedicated faucet");
    } finally { deployment.faucet = original; }
    expect(getMint).not.toHaveBeenCalled();
    expect(sendAndConfirmTransaction).not.toHaveBeenCalled();
  });
});

describe("cold-start faucet history protection", () => {
  const authority = Keypair.generate().publicKey, destination = Keypair.generate().publicKey;
  const now = 10_000_000;
  const signature = (blockTime: number | null, err: unknown = null) => ({ blockTime, err });
  function fixture(global: object[], wallet: object[]) {
    const client = devnetClient();
    vi.spyOn(client.connection, "getSignaturesForAddress").mockImplementation(async (address) => (address.equals(authority) ? global : wallet) as never);
    return client;
  }
  it("rejects ten confirmed authority transactions in the last hour, but ignores older and failed ones", async () => {
    await expect(checkFaucetHistory(fixture(Array(10).fill(signature(9999)), []), authority, destination, now)).rejects.toThrow("hourly limit");
    await expect(checkFaucetHistory(fixture([signature(6400), signature(9999, { failure: true })], []), authority, destination, now)).resolves.toBeUndefined();
  });
  it("enforces the wallet cooldown across fresh instances and fails closed on missing history", async () => {
    await expect(checkFaucetHistory(fixture([], [signature(9401)]), authority, destination, now)).rejects.toThrow("10 minutes");
    await expect(checkFaucetHistory(fixture([], [signature(9400)]), authority, destination, now)).resolves.toBeUndefined();
    await expect(checkFaucetHistory(fixture([signature(null)], []), authority, destination, now)).rejects.toThrow("history is unavailable");
    await expect(checkFaucetHistory(fixture([], [signature(null)]), authority, destination, now)).rejects.toThrow("10 minutes");
  });
});

describe("Vercel parsed-body and Vite streamed-body compatibility", () => {
  it("accepts either transport with the same JSON object rules", async () => {
    const value = { live: false, vault: deployment.pool };
    const stream = Readable.from([Buffer.from(JSON.stringify(value))]) as IncomingMessage;
    expect(await readBody(stream)).toEqual(value);
    expect(await readBody({ body: value } as unknown as IncomingMessage)).toEqual(value);
  });
  it("rejects oversized, malformed, array, null and string bodies before execution", async () => {
    for (const value of [null, [], "not-json"]) await expect(readBody({ body: value } as unknown as IncomingMessage)).rejects.toThrow("JSON object");
    await expect(readBody({ body: { padding: "x".repeat(4096) } } as unknown as IncomingMessage)).rejects.toThrow("too large");
    await expect(readBody({ get body() { throw new Error("private parser error"); } } as unknown as IncomingMessage)).rejects.toThrow("JSON object");
  });
});

describe("rolling IP limits", () => {
  it("expires allowances without resetting other IPs or endpoint groups", () => {
    let now = 0; const limiter = new IpLimiter(() => now);
    for (let i = 0; i < 6; i++) limiter.take("one", "agent");
    expect(() => limiter.take("one", "agent")).toThrow("IP limit");
    limiter.take("one", "faucet"); limiter.take("two", "agent");
    now = 60_000; expect(() => limiter.take("one", "agent")).not.toThrow();
    expect(() => limiter.take("one", "faucet")).toThrow("IP limit");
    now = 600_000; expect(() => limiter.take("one", "faucet")).not.toThrow();
  });
});
