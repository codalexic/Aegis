import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { sendServerTransaction } from "../../../packages/sdk/src/server-transaction";
import { environmentSigner, checkFaucetHistory, devnetClient, mintTestUsdc, deployment } from "../server/devnet-service";
import { IpLimiter } from "../server/public-limits";
import { readBody } from "../server/http";

vi.mock("../../../packages/sdk/src/server-transaction", () => ({ sendServerTransaction: vi.fn() }));
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
    vi.mocked(sendServerTransaction).mockResolvedValue({ ok: true, signature: "test-only-signature" });
    const recipient = Keypair.generate().publicKey;
    const result = await mintTestUsdc({ AEGIS_FAUCET_SECRET: JSON.stringify(Array(64).fill(1)) }, recipient);
    expect(result).toEqual({ signature: "test-only-signature", amountRaw: "1000000000" });
    const [, signer, build] = vi.mocked(sendServerTransaction).mock.calls[0];
    const transaction = { instructions: await build() };
    expect(signer).toBe(authority);
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
    expect(sendServerTransaction).not.toHaveBeenCalled();
  });
  it.each([deployment.owner, Keypair.generate().publicKey.toBase58()])("rejects a secret for %s before RPC or sending", async (publicKey) => {
    vi.spyOn(Keypair, "fromSecretKey").mockReturnValue({ publicKey: new PublicKey(publicKey) } as Keypair);
    await expect(mintTestUsdc({ AEGIS_FAUCET_SECRET: JSON.stringify(Array(64).fill(1)) }, Keypair.generate().publicKey)).rejects.toThrow("AEGIS_FAUCET_SECRET is missing or does not match");
    expect(getMint).not.toHaveBeenCalled();
    expect(sendServerTransaction).not.toHaveBeenCalled();
  });
  it.each([undefined, deployment.owner])("rejects a missing or deployer faucet in the manifest", async (faucet) => {
    const original = deployment.faucet;
    try {
      deployment.faucet = faucet as string;
      await expect(mintTestUsdc({}, Keypair.generate().publicKey)).rejects.toThrow("dedicated faucet");
    } finally { deployment.faucet = original; }
    expect(getMint).not.toHaveBeenCalled();
    expect(sendServerTransaction).not.toHaveBeenCalled();
  });
});

describe("cold-start faucet history protection", () => {
  const authority = Keypair.generate().publicKey, destination = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;
  const now = 10_000_000;
  function mint(account = other, type = "mintToChecked") {
    return { programId: TOKEN_PROGRAM_ID, parsed: { type, info: {
      mint: deployment.inputMint, account: account.toBase58(), mintAuthority: authority.toBase58(),
    } } };
  }
  function record(blockTime: number | null, instructions = [mint()], signer = true, err: object | null = null) {
    return { blockTime, meta: { err }, transaction: { message: {
      accountKeys: [{ pubkey: authority, signer }], instructions,
    } } };
  }
  function fixture(records: ReturnType<typeof record>[]) {
    const client = devnetClient();
    const signatures = vi.spyOn(client.connection, "getSignaturesForAddress").mockResolvedValue(records.map((tx, i) => ({
      signature: String(i), blockTime: tx.blockTime, err: tx.meta.err,
    })) as never);
    const parsed = vi.spyOn(client.connection, "getParsedTransactions").mockImplementation(async (ids) => ids.map((id) => records[Number(id)]) as never);
    return { client, signatures, parsed };
  }
  it("allows 29 claims and blocks 30 with minutes from the rolling hour", async () => {
    const records = Array.from({ length: 30 }, () => record(7120));
    await expect(checkFaucetHistory(fixture(records.slice(1)).client, authority, destination, now)).resolves.toBeUndefined();
    await expect(checkFaucetHistory(fixture(records).client, authority, destination, now)).rejects.toMatchObject({
      status: 429, message: "Faucet hourly limit reached. Try again in 12 minutes.", retryAfter: 720,
    });
    await expect(checkFaucetHistory(fixture(records).client, authority, destination, now + 720_000)).resolves.toBeUndefined();
  });
  it("waits for enough claims to expire when concurrent instances exceeded the cap", async () => {
    const records = [record(6401), ...Array.from({ length: 30 }, () => record(7120))];
    await expect(checkFaucetHistory(fixture(records).client, authority, destination, now)).rejects.toThrow("in 12 minutes.");
  });
  it.each(["mintTo", "mintToChecked"])("enforces only faucet %s cooldowns across fresh instances", async (type) => {
    const f = fixture([record(9820, [mint(destination, type)])]);
    await expect(checkFaucetHistory(f.client, authority, destination, now)).rejects.toMatchObject({
      status: 429, message: "This wallet can claim again in 7 minutes.", retryAfter: 420,
    });
    await expect(checkFaucetHistory(f.client, authority, destination, now + 419_999)).rejects.toThrow("in 1 minute.");
    await expect(checkFaucetHistory(f.client, authority, destination, now + 420_000)).resolves.toBeUndefined();
  });
  it("ignores owner transfers, including funding after a faucet mint whose cooldown has elapsed", async () => {
    const transfer = { programId: TOKEN_PROGRAM_ID, parsed: { type: "transferChecked", info: {
      mint: deployment.inputMint, account: destination.toBase58(), mintAuthority: authority.toBase58(),
    } } };
    const f = fixture([record(9999, [transfer], false), record(9400, [mint(destination)])]);
    await expect(checkFaucetHistory(f.client, authority, destination, now)).resolves.toBeUndefined();
    expect(f.signatures).toHaveBeenCalledOnce();
    expect(f.signatures).toHaveBeenCalledWith(authority, { limit: 1000 }, "confirmed");
  });
  it("still finds a recent faucet mint behind a newer owner transfer", async () => {
    const f = fixture([record(9999, [], false), record(9820, [mint(destination)])]);
    await expect(checkFaucetHistory(f.client, authority, destination, now)).rejects.toThrow("in 7 minutes.");
  });
  it("ignores failed, old, unsigned, other-mint and other-program transactions", async () => {
    const wrongMint = mint(destination); wrongMint.parsed.info.mint = other.toBase58();
    const wrongAuthority = mint(destination); wrongAuthority.parsed.info.mintAuthority = other.toBase58();
    const wrongProgram = mint(destination); wrongProgram.programId = other;
    const records = [record(6400), record(9999, [mint(destination)], true, { failure: true }),
      record(9999, [mint(destination)], false), record(9999, [wrongMint, wrongAuthority, wrongProgram])];
    await expect(checkFaucetHistory(fixture(Array.from({ length: 10 }, () => records).flat()).client, authority, destination, now)).resolves.toBeUndefined();
  });
  it("fails closed on missing, truncated or unavailable history", async () => {
    for (const records of [[record(null)], Array.from({ length: 1000 }, () => record(9999))]) {
      await expect(checkFaucetHistory(fixture(records).client, authority, destination, now)).rejects.toMatchObject({ status: 503 });
    }
    const f = fixture([record(9999)]);
    f.parsed.mockResolvedValue([null]);
    await expect(checkFaucetHistory(f.client, authority, destination, now)).rejects.toThrow("history is unavailable");
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
  it("keeps six agent calls per minute separate from the faucet and other IPs", () => {
    let now = 0; const limiter = new IpLimiter(() => now);
    for (let i = 0; i < 6; i++) limiter.take("one", "agent");
    expect(() => limiter.take("one", "agent")).toThrow("Agent IP limit reached. Try again in 1 minute.");
    limiter.take("one", "faucet"); limiter.take("two", "agent");
    now = 60_000; expect(() => limiter.take("one", "agent")).not.toThrow();
  });
  it("allows ten faucet calls per IP and reports the actual time until an allowance expires", () => {
    let now = 0; const limiter = new IpLimiter(() => now);
    for (let i = 0; i < 10; i++) limiter.take("one", "faucet");
    expect(() => limiter.take("one", "faucet")).toThrow("Faucet busy on this network. Try again in 10 minutes.");
    expect(() => limiter.take("two", "faucet")).not.toThrow();
    now = 360_001;
    expect(() => limiter.take("one", "faucet")).toThrow("Try again in 4 minutes.");
    now = 599_999;
    expect(() => limiter.take("one", "faucet")).toThrow("Try again in 1 minute.");
    now = 600_000; expect(() => limiter.take("one", "faucet")).not.toThrow();
  });
  it("reports the next entry expiry when the IP table is full", () => {
    let now = 0; const limiter = new IpLimiter(() => now);
    for (let i = 0; i < 10_000; i++) limiter.take(String(i), "faucet");
    now = 360_000;
    expect(() => limiter.take("new", "faucet")).toThrow("Demo is busy. Try again in 4 minutes.");
    now = 600_000;
    expect(() => limiter.take("new", "faucet")).not.toThrow();
  });
});
