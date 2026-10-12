import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { Keypair } from "@solana/web3.js";
import { sendServerTransaction } from "../../../packages/sdk/src/server-transaction";
import { getMint } from "@solana/spl-token";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaucetLimiter, faucetApiMiddleware } from "../server/faucet-api";
import deployment from "../../../deployments/localnet.json";
import devnet from "../../../deployments/devnet.json";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn() }));
vi.mock("../../../packages/sdk/src/server-transaction", () => ({ sendServerTransaction: vi.fn() }));
vi.mock("@solana/spl-token", async (original) => ({ ...await original<object>(), getMint: vi.fn() }));
afterEach(() => vi.clearAllMocks());

async function serverTest(run: (url: string) => Promise<void>, environment: "localnet" | "devnet" = "localnet") {
  const middleware = faucetApiMiddleware("/unused", environment);
  const server = createServer((req, res) => middleware(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe("test-token faucet allowance", () => {
  it("reserves synchronously and allows the same wallet only after ten minutes", () => {
    let now = 0;
    const limiter = new FaucetLimiter(() => now);
    limiter.take("one");
    expect(() => limiter.take("one")).toThrow("This wallet can claim again in 10 minutes.");
    limiter.take("two");
    now = 180_001;
    expect(() => limiter.take("one")).toThrow("This wallet can claim again in 7 minutes.");
    now = 599_999;
    expect(() => limiter.take("one")).toThrow("in 1 minute.");
    now++;
    expect(() => limiter.take("one")).not.toThrow();
  });
  it("releases only the rejected reservation when claims share a timestamp", () => {
    const limiter = new FaucetLimiter(() => 0);
    for (let i = 0; i < 30; i++) limiter.take(String(i));
    limiter.release("0");
    limiter.release("0");
    expect(() => limiter.take("1")).toThrow("This wallet can claim again in 10 minutes.");
    expect(() => limiter.take("replacement")).not.toThrow();
    expect(() => limiter.take("extra")).toThrow("hourly limit");
  });
  it("caps all wallets at thirty claims per rolling hour, even after individual cooldowns", () => {
    let now = 0;
    const limiter = new FaucetLimiter(() => now);
    for (let i = 0; i < 30; i++) limiter.take(String(i));
    expect(() => limiter.take("new wallet")).toThrow("Faucet hourly limit reached. Try again in 60 minutes.");
    now = 600_000;
    expect(() => limiter.take("0")).toThrow("Faucet hourly limit reached. Try again in 50 minutes.");
    now = 2_880_001;
    expect(() => limiter.take("new wallet")).toThrow("Try again in 12 minutes.");
    now = 3_599_999;
    expect(() => limiter.take("new wallet")).toThrow("Try again in 1 minute.");
    now = 3_600_000;
    expect(() => limiter.take("0")).not.toThrow();
  });
});

describe("faucet HTTP boundary", () => {
  it.each(["valid", "wrong-key", "wrong-authority", "missing-faucet", "deployer-faucet"])("uses the dedicated local devnet key: %s", async (kind) => serverTest(async (url) => {
    const faucet = Keypair.generate();
    const owner = Keypair.generate();
    const manifest = { ...devnet, owner: owner.publicKey.toBase58(), faucet: kind === "missing-faucet" ? undefined :
      kind === "deployer-faucet" ? owner.publicKey.toBase58() : faucet.publicKey.toBase58() };
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (String(path).endsWith("deployments/devnet.json")) return JSON.stringify(manifest);
      if (String(path).endsWith(".keys/devnet-faucet.json")) return JSON.stringify(Array.from((kind === "wrong-key" ? owner : faucet).secretKey));
      throw new Error("Unexpected file read");
    });
    vi.mocked(getMint).mockResolvedValue({ decimals: 6, mintAuthority: kind === "wrong-authority" ? owner.publicKey : faucet.publicKey } as Awaited<ReturnType<typeof getMint>>);
    vi.mocked(sendServerTransaction).mockResolvedValue({ ok: true, signature: "test-only-signature" });
    const response = await fetch(`${url}/api/faucet`, { method: "POST", headers: { origin: url, "content-type": "application/json", "x-aegis-faucet": "devnet" }, body: JSON.stringify({ wallet: owner.publicKey.toBase58() }) });
    expect(readFile).not.toHaveBeenCalledWith("/unused/.keys/devnet-deployer.json", "utf8");
    expect(response.status).toBe(kind === "valid" ? 200 : 503);
    if (kind === "valid") {
      expect([vi.mocked(sendServerTransaction).mock.calls[0][1].publicKey.toBase58()]).toEqual([faucet.publicKey.toBase58()]);
    } else {
      expect(sendServerTransaction).not.toHaveBeenCalled();
      if (kind !== "wrong-authority") expect(getMint).not.toHaveBeenCalled();
    }
  }, "devnet"));

  it("rejects cross-origin claims before reading any files", async () => serverTest(async (url) => {
    const response = await fetch(`${url}/api/faucet`, { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json", "x-aegis-faucet": "localnet" }, body: "{}" });
    expect(response.status).toBe(403);
    expect(readFile).not.toHaveBeenCalled();
  }));

  it.each([{}, { wallet: "invalid" }, { wallet: deployment.owner, amount: "100000000000" }, { wallet: deployment.pool }])("rejects invalid claims %j before reading mint authority", async (body) => serverTest(async (url) => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(deployment));
    const response = await fetch(`${url}/api/faucet`, { method: "POST", headers: { origin: url, "content-type": "application/json", "x-aegis-faucet": "localnet" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("/unused/deployments/localnet.json", "utf8");
  }));

  it("projects only public fields from the selected devnet manifest", async () => serverTest(async (url) => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...deployment, environment: "devnet", rpcUrl: "https://api.devnet.solana.com", wsUrl: "wss://api.devnet.solana.com", unexpected: "must not be returned" }));
    const response = await fetch(`${url}/api/deployment`);
    const value = await response.json();
    expect(response.status).toBe(200);
    expect(value).toMatchObject({ environment: "devnet", agent: deployment.agent });
    expect(value).not.toHaveProperty("unexpected");
    expect(value).not.toHaveProperty("lastVault");
    expect(readFile).toHaveBeenCalledWith("/unused/deployments/devnet.json", "utf8");
  }, "devnet"));

  it("reports an undeployed devnet without reading keys or exposing exception text", async () => serverTest(async (url) => {
    vi.mocked(readFile).mockRejectedValue(new Error("private configuration"));
    const response = await fetch(`${url}/api/deployment`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "No devnet deployment. Run pnpm devnet:deploy first." });
    expect(readFile).toHaveBeenCalledTimes(1);
  }, "devnet"));
});
