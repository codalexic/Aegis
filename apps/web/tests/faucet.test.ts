import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FaucetLimiter, faucetApiMiddleware } from "../server/faucet-api";
import deployment from "../../../deployments/localnet.json";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn() }));
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
    expect(() => limiter.take("one")).toThrow("once per 10 minutes");
    limiter.take("two");
    now = 599_999;
    expect(() => limiter.take("one")).toThrow("1 minutes");
    now++;
    expect(() => limiter.take("one")).not.toThrow();
  });
  it("caps all wallets at ten claims per rolling hour, even after individual cooldowns", () => {
    let now = 0;
    const limiter = new FaucetLimiter(() => now);
    for (let i = 0; i < 10; i++) limiter.take(String(i));
    expect(() => limiter.take("new wallet")).toThrow("hourly limit");
    now = 600_000;
    expect(() => limiter.take("0")).toThrow("hourly limit");
    now = 3_600_000;
    expect(() => limiter.take("0")).not.toThrow();
  });
});

describe("faucet HTTP boundary", () => {
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
