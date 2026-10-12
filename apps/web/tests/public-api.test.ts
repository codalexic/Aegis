import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BLOCKCHAIN_IDS } from "@solana/actions";
import { createPublicHandler, siteOrigin } from "../server/public-api";
import { deployment, devnetClient, environmentSigner, mintTestUsdc } from "../server/devnet-service";
import { ActionsService } from "../api/actions/service";
import { askModel, ModelHttpError } from "../../../scripts/agent/model";
import { MockAegisClient } from "../../../packages/sdk/src/mock";
import { ApiError } from "../server/http";

vi.mock("../server/devnet-service", async (original) => ({ ...await original<object>(), devnetClient: vi.fn(), environmentSigner: vi.fn(), mintTestUsdc: vi.fn() }));
vi.mock("../../../scripts/agent/model", async (original) => ({ ...await original<object>(), askModel: vi.fn() }));
let server: Server, url: string, vault: PublicKey, client: MockAegisClient;
const agent = Keypair.generate(), owner = Keypair.generate();
const env = { AEGIS_PUBLIC_ORIGIN: "https://aegis.example", GEMINI_API_KEY: "test-provider-credential" };
const headers = (actor = "agent", ip = "203.0.113.1") => ({ origin: env.AEGIS_PUBLIC_ORIGIN, "content-type": "application/json", [`x-aegis-${actor}`]: "devnet", "x-vercel-forwarded-for": ip });
const post = (action: string, body: unknown = { live: false, vault: vault.toBase58() }, extra = {}) => fetch(`${url}/api/agent/${action}`, { method: "POST", headers: { ...headers(), ...extra }, body: JSON.stringify(body) });
beforeEach(async () => {
  client = new MockAegisClient();
  const created = await client.createVault(owner, { vaultId: 0n, agent: agent.publicKey, maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: BigInt(Math.floor(Date.now() / 1000)) + 3600n });
  if (!created.ok || !created.vault) throw new Error();
  vault = created.vault;
  await client.fundVault(owner, vault, 1_000_000_000n);
  vi.mocked(devnetClient).mockReturnValue(client as unknown as ReturnType<typeof devnetClient>);
  vi.mocked(environmentSigner).mockReturnValue(agent);
  vi.mocked(mintTestUsdc).mockResolvedValue({ signature: "test-only", amountRaw: "1000000000" });
  const handler = createPublicHandler(env);
  server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error();
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("public devnet functions", () => {
  it("serves public deployment/info without loading credentials and has no owner routes", async () => {
    expect(await (await fetch(`${url}/api/deployment`)).json()).toEqual(deployment);
    expect(await (await fetch(`${url}/api/agent/info`)).json()).toMatchObject({ environment: "devnet", agent: deployment.agent, model: expect.any(String) });
    for (const path of ["/api/owner/create", "/api/localnet", "/api/agent/scripted"]) expect((await fetch(`${url}${path}`)).status).toBe(404);
    expect(environmentSigner).not.toHaveBeenCalled();
    expect((await fetch(`${url}/api/agent/normal`)).status).toBe(405);
  });
  it.each(["normal", "injected", "attacker"])("runs the scripted %s scenario without AI", async (action) => {
    const response = await post(action);
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.steps).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining(action === "normal" ? { ok: true } : { ok: false, error: action === "injected" ? "CapExceeded" : "AccountMismatch" }) }));
    expect(askModel).not.toHaveBeenCalled();
  });
  it("checks the vault agent before model calls and trades", async () => {
    await client.rotateAgent(owner, vault, Keypair.generate().publicKey);
    const swap = vi.spyOn(client, "swap");
    const response = await post("normal", { live: true, vault: vault.toBase58() });
    expect(response.status).toBe(403);
    expect(askModel).not.toHaveBeenCalled(); expect(swap).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])("automatically runs a recorded reply after Gemini %s and hides provider diagnostics", async (status) => {
    vi.mocked(askModel).mockRejectedValueOnce(new ModelHttpError(status, "gemini", "private-provider-diagnostic"));
    const response = await post("normal", { live: true, vault: vault.toBase58() });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.steps).toContainEqual(expect.objectContaining({ type: "model_reply", source: "scripted" }));
    expect(data.steps).toContainEqual(expect.objectContaining({ type: "notice", code: "live_fallback" }));
    expect(data.steps).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ ok: true }) }));
    expect((await client.getVault(vault)).spentRaw).toBe(20_000_000n);
    expect(JSON.stringify(data)).not.toMatch(/HTTP|429|503/);
    expect(JSON.stringify(data)).not.toMatch(/private-provider|test-provider-credential/);
  });
  it.each([{}, { live: "false", vault: "invalid" }, { live: false, vault: "invalid" }, { live: false, vault: deployment.pool, amount: "50" }])("rejects invalid agent input before loading keys: %j", async (body) => {
    expect((await post("normal", body)).status).toBe(400);
    expect(environmentSigner).not.toHaveBeenCalled();
  });
  it("rejects cross-origin, wrong cluster, missing trusted IP, and oversized input", async () => {
    expect((await post("normal", undefined, { origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await post("normal", undefined, { "x-aegis-agent": "localnet" })).status).toBe(403);
    expect((await post("normal", undefined, { "x-vercel-forwarded-for": "" })).status).toBe(503);
    expect((await post("normal", { live: false, vault: "x".repeat(5000) })).status).toBe(413);
    expect(environmentSigner).not.toHaveBeenCalled();
  });
  it("limits agent requests across scenarios per trusted IP, ignoring spoofed forwarding headers", async () => {
    for (let i = 0; i < 6; i++) expect((await post("normal", {})).status).toBe(400);
    const response = await post("attacker", undefined, { "x-forwarded-for": "203.0.113.99" });
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60");
    expect((await post("normal", {}, { "x-vercel-forwarded-for": "203.0.113.2" })).status).toBe(400);
  });
  it("limits the faucet by IP, wallet and hourly allowance before minting", async () => {
    const claim = (wallet: string, ip: string) => fetch(`${url}/api/faucet`, { method: "POST", headers: headers("faucet", ip), body: JSON.stringify({ wallet }) });
    expect((await claim(owner.publicKey.toBase58(), "203.0.113.1")).status).toBe(200);
    for (let i = 1; i < 10; i++) expect((await claim(Keypair.generate().publicKey.toBase58(), "203.0.113.1")).status).toBe(200);
    const ipLimit = await claim(agent.publicKey.toBase58(), "203.0.113.1");
    expect(ipLimit.status).toBe(429);
    expect(await ipLimit.json()).toEqual({ error: "Faucet busy on this network. Try again in 10 minutes." });
    expect(ipLimit.headers.get("retry-after")).toBe("600");
    const walletLimit = await claim(owner.publicKey.toBase58(), "203.0.113.2");
    expect(walletLimit.status).toBe(429);
    expect(await walletLimit.json()).toEqual({ error: "This wallet can claim again in 10 minutes." });
    for (let i = 3; i < 23; i++) expect((await claim(Keypair.generate().publicKey.toBase58(), `203.0.113.${i}`)).status).toBe(200);
    const hourlyLimit = await claim(agent.publicKey.toBase58(), "203.0.113.23");
    expect(hourlyLimit.status).toBe(429);
    expect(await hourlyLimit.json()).toEqual({ error: "Faucet hourly limit reached. Try again in 60 minutes." });
    expect(hourlyLimit.headers.get("retry-after")).toBe("3600");
    expect(mintTestUsdc).toHaveBeenCalledTimes(30);
  });
  it("preserves chain-history retry times without starting another local cooldown", async () => {
    vi.mocked(mintTestUsdc).mockRejectedValueOnce(new ApiError(429, "This wallet can claim again in 7 minutes.", 420));
    const claim = () => fetch(`${url}/api/faucet`, { method: "POST", headers: headers("faucet"), body: JSON.stringify({ wallet: owner.publicKey.toBase58() }) });
    const limited = await claim();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("420");
    expect(await limited.json()).toEqual({ error: "This wallet can claim again in 7 minutes." });
    // History admits the next attempt: a rejected claim must not leave a local reservation.
    expect((await claim()).status).toBe(200);
    expect(mintTestUsdc).toHaveBeenCalledTimes(2);
  });
  it("retains the reservation after an uncertain send", async () => {
    vi.mocked(mintTestUsdc).mockRejectedValueOnce(new Error("Uncertain RPC send"));
    const claim = () => fetch(`${url}/api/faucet`, { method: "POST", headers: headers("faucet"), body: JSON.stringify({ wallet: owner.publicKey.toBase58() }) });
    expect((await claim()).status).toBe(503);
    const limited = await claim();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "This wallet can claim again in 10 minutes." });
    expect(mintTestUsdc).toHaveBeenCalledOnce();
  });
  it("hides unexpected exceptions and unlocks the vault after a failed request", async () => {
    vi.mocked(environmentSigner).mockImplementationOnce(() => { throw new Error("private-key-data"); });
    const response = await post("normal");
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-key-data");
    expect((await post("normal")).status).toBe(200);
  });
  it("keeps a pending vault request locked", async () => {
    let release!: (value: string) => void;
    vi.mocked(askModel).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = post("normal", { live: true, vault: vault.toBase58() });
    await vi.waitFor(() => expect(askModel).toHaveBeenCalledOnce());
    try { expect((await post("attacker")).status).toBe(409); }
    finally { release('{"amountUsdc":"20","reason":"Calm"}'); await pending; }
  });
  it("keeps devnet Actions headers on configuration failures", async () => {
    const actual = await vi.importActual<typeof import("../server/devnet-service")>("../server/devnet-service");
    vi.mocked(devnetClient).mockReturnValue(actual.devnetClient());
    const previous = env.AEGIS_PUBLIC_ORIGIN;
    env.AEGIS_PUBLIC_ORIGIN = "invalid";
    try {
      const response = await fetch(`${url}/api/actions/create`);
      expect(response.status).toBe(503);
      expect(response.headers.get("x-blockchain-ids")).toBe(BLOCKCHAIN_IDS.devnet);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    } finally { env.AEGIS_PUBLIC_ORIGIN = previous; }
  });
  it("serves Actions GET/POST/OPTIONS with devnet headers without server signing", async () => {
    const actual = await vi.importActual<typeof import("../server/devnet-service")>("../server/devnet-service");
    vi.mocked(devnetClient).mockReturnValue(actual.devnetClient());
    const build = vi.spyOn(ActionsService.prototype, "build").mockResolvedValue({ type: "transaction", transaction: "unsigned-fixture", message: "Sign with your wallet" });
    for (const action of ["create", "fund", "revoke", "withdraw"]) {
      for (const method of ["GET", "OPTIONS", "POST"]) {
        const response = await fetch(`${url}/api/actions/${action}`, { method, headers: { "content-type": "application/json", origin: "https://dial.to" }, ...(method === "POST" && { body: JSON.stringify({ account: owner.publicKey.toBase58() }) }) });
        expect(response.status).toBe(method === "OPTIONS" ? 204 : 200);
        expect(response.headers.get("x-blockchain-ids")).toBe(BLOCKCHAIN_IDS.devnet);
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        if (method === "GET") expect((await response.json()).icon).toBe("https://aegis.example/aegis.png");
      }
    }
    expect(build).toHaveBeenCalledTimes(4); expect(environmentSigner).not.toHaveBeenCalled();
    build.mockRejectedValueOnce(new Error("private-internal-detail"));
    const failed = await fetch(`${url}/api/actions/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: owner.publicKey.toBase58() }) });
    expect(failed.status).toBe(503); expect(failed.headers.get("x-blockchain-ids")).toBe(BLOCKCHAIN_IDS.devnet);
    expect(await failed.text()).not.toContain("private-internal-detail");
  });
});

describe("canonical public origin", () => {
  it("uses Vercel's configured production or preview domain, never a request Host", () => {
    expect(siteOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "aegis.vercel.app" })).toBe("https://aegis.vercel.app");
    expect(siteOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "preview.vercel.app" })).toBe("https://preview.vercel.app");
    for (const origin of ["http://localhost:5173", "https://user:pass@example.com", "https://example.com/path"]) expect(() => siteOrigin({ AEGIS_PUBLIC_ORIGIN: origin })).toThrow(ApiError);
  });
});
