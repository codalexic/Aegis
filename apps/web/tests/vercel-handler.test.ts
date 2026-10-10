import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKCHAIN_IDS } from "@solana/actions";
import { Connection, Keypair, type PublicKey } from "@solana/web3.js";
import handler from "../../../scripts/vercel/handler";
import output from "../../../scripts/vercel/config.json";
import rules from "../public/actions.json";
import { ActionsService } from "../api/actions/service";
import { deployment, devnetClient, environmentSigner, mintTestUsdc } from "../server/devnet-service";
import { MockAegisClient } from "../../../packages/sdk/src/mock";

vi.mock("../server/devnet-service", async (original) => ({ ...await original<object>(),
  devnetClient: vi.fn(), environmentSigner: vi.fn(), mintTestUsdc: vi.fn(),
}));

const origin = "https://aegis.example";
const rewrite = output.routes.find(({ dest }) => dest?.startsWith("/api/handler?"))!;
const actions = ["create", "fund", "revoke", "withdraw"] as const;
let requestNumber = 0;

describe.each(["rewritten URL", "request.query", "original URL"] as const)("Vercel handler with %s", (shape) => {
  let server: Server, base: string, restoredUrl: string | undefined, owner: Keypair, vault: PublicKey;
  beforeEach(async () => {
    vi.stubEnv("AEGIS_PUBLIC_ORIGIN", origin);
    const agent = Keypair.generate();
    owner = Keypair.generate();
    const client = new MockAegisClient();
    const created = await client.createVault(owner, { vaultId: 0n, agent: agent.publicKey,
      maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: BigInt(Math.floor(Date.now() / 1000)) + 3600n });
    if (!created.ok || !created.vault) throw new Error("Missing fixture vault");
    vault = created.vault;
    await client.fundVault(owner, vault, 1_000_000_000n);
    vi.mocked(devnetClient).mockReturnValue(Object.assign(client, {
      connection: new Connection(deployment.rpcUrl, "confirmed"),
    }) as unknown as ReturnType<typeof devnetClient>);
    vi.mocked(environmentSigner).mockReturnValue(agent);
    vi.mocked(mintTestUsdc).mockResolvedValue({ signature: "mock-faucet", amountRaw: "1000000000" });
    vi.spyOn(ActionsService.prototype, "build").mockResolvedValue({ type: "transaction", transaction: "unsigned-fixture", message: "Sign with your wallet" });
    vi.spyOn(ActionsService.prototype, "latestVault").mockResolvedValue(vault);
    server = createServer(async (request, response) => {
      const incoming = new URL(request.url!, origin);
      const destination = new URL(incoming.pathname.replace(new RegExp(rewrite.src!), rewrite.dest!), origin);
      for (const [key, value] of incoming.searchParams) destination.searchParams.append(key, value);
      const query = Object.fromEntries([...new Set(destination.searchParams.keys())].map((key) => {
        const values = destination.searchParams.getAll(key);
        return [key, values.length === 1 ? values[0] : values];
      }));
      request.url = shape === "rewritten URL" ? `${destination.pathname}${destination.search}`
        : shape === "request.query" ? `${destination.pathname}${incoming.search}`
          : `${incoming.pathname}${destination.search}`;
      // Vercel's Node runtime supplies parsed JSON bodies and query parameters.
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const pending = handler(Object.assign(request, { query, body }), response);
      restoredUrl = request.url;
      await pending;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
  });

  function post(path: string, body: unknown, actor?: "agent" | "faucet") {
    return fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body), headers: {
      "content-type": "application/json", origin: actor ? origin : "https://dial.to",
      // A distinct trusted test IP avoids sharing the imported handler's warm-instance limits.
      "x-vercel-forwarded-for": `203.0.113.${++requestNumber}`,
      ...(actor && { [`x-aegis-${actor}`]: "devnet" }),
    } });
  }
  function cors(response: Response) {
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-blockchain-ids")).toBe(BLOCKCHAIN_IDS.devnet);
    expect(response.headers.get("x-action-version")).toBe("2.4.1");
  }

  it("serves deployment and agent info", async () => {
    const response = await fetch(`${base}/api/deployment`);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(deployment);
    expect(restoredUrl).toBe("/api/deployment");
    const info = await fetch(`${base}/api/agent/info`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ environment: "devnet", agent: deployment.agent });
    expect(restoredUrl).toBe("/api/agent/info");
    expect(environmentSigner).not.toHaveBeenCalled();
  });

  it.each(["normal", "injected", "attacker"])("routes POST /api/agent/%s", async (action) => {
    const response = await post(`/api/agent/${action}`, { live: false, vault: vault.toBase58() }, "agent");
    expect(response.status).toBe(200);
    expect((await response.json()).steps).toContainEqual(expect.objectContaining({ type: "result",
      result: expect.objectContaining(action === "normal" ? { ok: true }
        : { ok: false, error: action === "injected" ? "CapExceeded" : "AccountMismatch" }),
    }));
    expect(restoredUrl).toBe(`/api/agent/${action}`);
  });

  it("routes POST /api/faucet with a parsed Vercel body", async () => {
    const response = await post("/api/faucet", { wallet: owner.publicKey.toBase58() }, "faucet");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signature: "mock-faucet", amountRaw: "1000000000" });
    expect(mintTestUsdc).toHaveBeenCalledWith(process.env, owner.publicKey);
    expect(restoredUrl).toBe("/api/faucet");
  });

  it.each(actions)("routes Actions GET/POST/OPTIONS for %s and preserves button parameters", async (action) => {
    const path = `/api/actions/${action}`;
    const get = await fetch(`${base}${path}`); cors(get); expect(get.status).toBe(200);
    const metadata = await get.json();
    expect(metadata.icon).toBe(`${origin}/aegis.png`);
    const button = metadata.links.actions[0].href.replace("{cap}", "9007199254.740993")
      .replace("{budget}", "18446744073709.551615").replace("{amount}", "20.000001");
    expect(button).toMatch(new RegExp(`^${path}(\\?|$)`));
    const response = await post(button, { account: owner.publicKey.toBase58() }); cors(response);
    expect(response.status).toBe(200); expect((await response.json()).transaction).toBe("unsigned-fixture");
    expect(ActionsService.prototype.build).toHaveBeenCalledWith(action, owner.publicKey,
      action === "create" ? { cap: "9007199254.740993", budget: "18446744073709.551615" }
        : action === "fund" ? { amount: "20.000001" } : {});
    expect(restoredUrl).toBe(button);
    const options = await fetch(`${base}${path}`, { method: "OPTIONS" }); cors(options); expect(options.status).toBe(204);
    expect(environmentSigner).not.toHaveBeenCalled();
  });

  it("routes latest-vault with only the original account query", async () => {
    const path = `/api/actions/latest-vault?account=${owner.publicKey.toBase58()}`;
    const response = await fetch(`${base}${path}`); cors(response); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ vault: vault.toBase58() });
    expect(ActionsService.prototype.latestVault).toHaveBeenCalledWith(owner.publicKey);
    expect(restoredUrl).toBe(path);
  });

  it("resolves every actions.json apiPath through the rewrite", async () => {
    for (const rule of rules.rules) {
      for (const action of rule.apiPath.includes("**") ? actions : ["create"]) {
        const path = rule.apiPath.replace("**", action);
        const response = await fetch(`${base}${path}`); cors(response);
        expect(response.status).toBe(200);
        expect((await response.json()).links.actions[0].href.split("?")[0]).toBe(path);
      }
    }
  });

  it("preserves duplicate and unknown query parameters for Actions validation", async () => {
    for (const query of ["amount=20&amount=40", "amount=20&destination=attacker"]) {
      const response = await post(`/api/actions/fund?${query}`, { account: owner.publicKey.toBase58() });
      cors(response); expect(response.status).toBe(400);
    }
    expect(ActionsService.prototype.build).not.toHaveBeenCalled();
  });

  it("keeps unknown and localnet-only routes unavailable", async () => {
    for (const path of ["/api", "/api/unknown", "/api/owner/create", "/api/agent/scripted", "/api/actions/unknown"]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect(environmentSigner).not.toHaveBeenCalled();
  });
});

it("keeps the Actions page rewrite and static discovery headers", () => {
  expect(output.routes).toContainEqual({ src: "^/actions(?:/.*)?$", dest: "/index.html" });
  const headers = output.routes.find(({ src }) => src === "^/actions\\.json$")!.headers!;
  expect(Object.entries(headers).map(([key, value]) => ({ key, value }))).toEqual([
    { key: "Access-Control-Allow-Origin", value: "*" },
    { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
    { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, Content-Encoding, Accept-Encoding" },
    { key: "Access-Control-Expose-Headers", value: "X-Blockchain-Ids, X-Action-Version" },
    { key: "X-Blockchain-Ids", value: BLOCKCHAIN_IDS.devnet },
    { key: "X-Action-Version", value: "2.4.1" },
  ]);
});
