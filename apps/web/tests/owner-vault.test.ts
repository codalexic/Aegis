import { createServer, type Server } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveVaultPda } from "../../../packages/sdk/src/index";
import { ownerApiMiddleware } from "../server/owner-api";

const client = vi.hoisted(() => ({
  connection: { getSlot: vi.fn(), getBlockTime: vi.fn() },
  createVault: vi.fn(), fundVault: vi.fn(), revoke: vi.fn(), withdraw: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn(), writeFile: vi.fn(), rename: vi.fn() }));
vi.mock("../../../packages/sdk/src/index", async (original) => ({
  ...await original<typeof import("../../../packages/sdk/src/index")>(),
  AnchorAegisClient: class { constructor() { return client; } },
}));

describe("fresh demo vault and selected owner actions", () => {
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(21));
  const agent = new PublicKey(new Uint8Array(32).fill(22));
  const oldVault = deriveVaultPda(owner.publicKey, 0n)[0];
  let deployment: Record<string, unknown>;
  let saved: string;
  let server: Server;
  let origin: string;
  async function post(action: string, body = {}) {
    return fetch(`${origin}/api/owner/${action}`, { method: "POST", headers: {
      origin, "content-type": "application/json", "x-aegis-owner": "localnet",
    }, body: JSON.stringify(body) });
  }
  beforeEach(async () => {
    vi.resetAllMocks();
    deployment = { environment: "localnet", owner: owner.publicKey.toBase58(), agent: agent.toBase58(),
      programs: { aegis: oldVault.toBase58(), demoDex: oldVault.toBase58() }, lastVault: oldVault.toBase58() };
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (String(path).endsWith("deployments/localnet.json")) return JSON.stringify(deployment);
      if (String(path).endsWith(".keys/owner.json")) return JSON.stringify(Array.from(owner.secretKey));
      throw new Error("Unexpected read");
    });
    vi.mocked(writeFile).mockImplementation(async (_path, contents) => { saved = String(contents); });
    vi.mocked(rename).mockImplementation(async () => { deployment = JSON.parse(saved); });
    client.connection.getSlot.mockResolvedValue(123);
    client.connection.getBlockTime.mockResolvedValue(1_800_000_000);
    client.createVault.mockImplementation(async (_owner, params) => ({ ok: true, signature: "create-signature",
      vault: deriveVaultPda(owner.publicKey, params.vaultId)[0] }));
    client.fundVault.mockResolvedValue({ ok: true, signature: "fund-signature" });
    client.revoke.mockResolvedValue({ ok: true, signature: "revoke-signature" });
    client.withdraw.mockResolvedValue({ ok: true, signature: "withdraw-signature" });
    const middleware = ownerApiMiddleware("/fixture");
    server = createServer((request, response) => middleware(request, response, () => response.writeHead(404).end()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it("creates distinct vaults with the fixed policy, funds 1,000, and persists the selection", async () => {
    const first = await (await post("new-demo")).json();
    const second = await (await post("new-demo")).json();
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, signature: "fund-signature", createSignature: "create-signature" });
    expect(first.vault).not.toBe(oldVault.toBase58());
    expect(second.vault).not.toBe(first.vault);
    const params = client.createVault.mock.calls[1][1];
    expect(typeof params.vaultId).toBe("bigint");
    expect(params).toMatchObject({ agent, maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: 1_800_003_600n });
    expect(client.fundVault).toHaveBeenLastCalledWith(owner, new PublicKey(second.vault), 1_000_000_000n);
    expect(deployment.lastVault).toBe(second.vault);
    expect(await (await fetch(`${origin}/api/localnet`)).json()).toMatchObject({ lastVault: second.vault });
    await post("fund");
    await post("revoke");
    await post("withdraw", { mint: agent.toBase58(), amountRaw: "9007199254740993" });
    expect(client.fundVault).toHaveBeenLastCalledWith(owner, new PublicKey(second.vault), 1_000_000_000n);
    expect(client.revoke).toHaveBeenCalledWith(owner, new PublicKey(second.vault));
    expect(client.withdraw).toHaveBeenCalledWith(owner, new PublicKey(second.vault), agent, 9_007_199_254_740_993n);
  });

  it.each([false, true])("keeps a created vault selected when funding fails (exception: %s)", async (exception) => {
    if (exception) client.fundVault.mockRejectedValueOnce(new Error("private RPC details"));
    else client.fundVault.mockResolvedValueOnce({ ok: false, error: "InsufficientFunds", origin: "program" });
    const result = await (await post("new-demo")).json();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Use Fund 1,000 to retry");
    expect(JSON.stringify(result)).not.toContain("private RPC details");
    expect(deployment.lastVault).toBe(result.vault);
    expect((await (await post("fund")).json()).ok).toBe(true);
    expect(client.fundVault).toHaveBeenLastCalledWith(owner, new PublicKey(result.vault), 1_000_000_000n);
  });

  it("does not fund or switch vaults when creation fails", async () => {
    client.createVault.mockResolvedValueOnce({ ok: false, error: "Unavailable", origin: "rpc" });
    expect((await (await post("new-demo")).json()).ok).toBe(false);
    expect(client.fundVault).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(deployment.lastVault).toBe(oldVault.toBase58());
  });

  it("rejects browser-selected vaults, amounts, or policy overrides", async () => {
    expect((await post("new-demo", { vaultId: "1", amountRaw: "1" })).status).toBe(400);
    expect(client.createVault).not.toHaveBeenCalled();
  });
});
