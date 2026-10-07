import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AnchorAegisClient, type ChainDeployment } from "../../../packages/sdk/src/anchor";
import { actionsPlugin } from "../api/actions/plugin";
import { faucetApiPlugin } from "../server/faucet-api";
import { agentApiPlugin } from "../server/agent-api";
import { connectWalletDashboard } from "../src/wallet-client";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const owner = Keypair.generate(); // In-memory test signer; never passed to any HTTP route.
let server: ViteDevServer, url: string, connection: Connection, deployment: ChainDeployment, client: AnchorAegisClient, vault: PublicKey, chainId: string;
let cacheDir: string;
const fetcher = globalThis.fetch;

beforeAll(async () => {
  deployment = JSON.parse(await readFile(`${root}/deployments/localnet.json`, "utf8"));
  expect(deployment.environment).toBe("localnet");
  expect(new URL(deployment.rpcUrl).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  connection = new Connection(deployment.rpcUrl, "confirmed"); client = new AnchorAegisClient({ deployment, connection });
  const funded = await connection.requestAirdrop(owner.publicKey, 1_000_000_000);
  expect((await connection.confirmTransaction(funded, "confirmed")).value.err).toBeNull();
  chainId = `solana:${(await connection.getGenesisHash()).slice(0, 32)}`;
  cacheDir = await mkdtemp(join(tmpdir(), "aegis-actions-test-"));
  server = await createServer({ configFile: false, root: `${root}/apps/web`, cacheDir, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom", logLevel: "error",
    server: { host: "127.0.0.1", port: 0 }, plugins: [actionsPlugin(root, "localnet"), faucetApiPlugin(root, "localnet"), agentApiPlugin(root, "localnet", true)] });
  await server.listen(); url = server.resolvedUrls!.local[0].replace(/\/$/, "");
  const faucet = await fetch(`${url}/api/faucet`, { method: "POST", headers: { origin: url, "content-type": "application/json", "x-aegis-faucet": "localnet" }, body: JSON.stringify({ wallet: owner.publicKey.toBase58() }) });
  expect(faucet.status, await faucet.text()).toBe(200);
});
afterAll(async () => { vi.unstubAllGlobals(); await server?.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });

function headers(response: Response) {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("x-blockchain-ids")).toBe(chainId);
  expect(response.headers.get("x-action-version")).toBe("2.4.1");
}
async function post(action: string, query = "") {
  const response = await fetch(`${url}/api/actions/${action}${query}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://blink-client.example" }, body: JSON.stringify({ account: owner.publicKey.toBase58() }) });
  headers(response);
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result.type).toBe("transaction");
  const transaction = VersionedTransaction.deserialize(Buffer.from(result.transaction, "base64"));
  expect(transaction.message.header.numRequiredSignatures).toBe(1);
  expect(transaction.message.staticAccountKeys[0].equals(owner.publicKey)).toBe(true);
  expect(transaction.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/secretKey|AIza/);
  return transaction;
}
async function signAndConfirm(transaction: VersionedTransaction) {
  transaction.sign([owner]);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  expect((await connection.confirmTransaction(signature, "confirmed")).value.err).toBeNull();
  return signature;
}
async function latest(account = owner.publicKey) {
  const response = await fetch(`${url}/api/actions/latest-vault?account=${account.toBase58()}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).vault;
}

describe("Actions on a local Vite dev server and real localnet", () => {
  it("GET and OPTIONS discover all four actions, their parameters and the PNG icon", async () => {
    for (const action of ["create", "fund", "revoke", "withdraw"]) {
      const response = await fetch(`${url}/api/actions/${action}`); headers(response); expect(response.status).toBe(200);
      const metadata = await response.json();
      expect(metadata).toMatchObject({ type: "action", title: expect.any(String), description: expect.stringContaining("localnet"), icon: `${url}/aegis.png` });
      expect(metadata.links.actions[0]).toMatchObject({ type: "transaction", href: expect.stringContaining(`/api/actions/${action}`) });
      expect(metadata.links.actions[0].parameters?.map((parameter: { name: string }) => parameter.name) ?? []).toEqual(action === "create" ? ["cap", "budget"] : action === "fund" ? ["amount"] : []);
      const options = await fetch(`${url}/api/actions/${action}`, { method: "OPTIONS", headers: { origin: "https://dial.to", "access-control-request-method": "POST" } });
      headers(options); expect(options.status).toBe(204);
    }
    const discovery = await fetch(`${url}/actions.json`); headers(discovery);
    expect((await discovery.json()).rules).toContainEqual({ pathPattern: "/api/actions/**", apiPath: "/api/actions/**" });
    const options = await fetch(`${url}/actions.json`, { method: "OPTIONS" }); headers(options); expect(options.status).toBe(204);
    const icon = await fetch(`${url}/aegis.png`);
    expect(icon.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await icon.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const privateApi = await fetch(`${url}/api/faucet`, { method: "POST", headers: { origin: "https://dial.to", "content-type": "application/json", "x-aegis-faucet": "localnet" }, body: JSON.stringify({ wallet: owner.publicKey.toBase58() }) });
    expect(privateApi.status).toBe(403);
    expect(privateApi.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("POST create is unsigned until the owner signs, then creates the configured policy and appears in the wallet dashboard", async () => {
    expect(await latest()).toBeNull();
    const unsigned = await post("create");
    vault = TransactionMessage.decompile(unsigned.message).instructions[0].keys[1].pubkey;
    expect(await connection.getAccountInfo(vault)).toBeNull();
    expect(await latest()).toBeNull();
    await signAndConfirm(unsigned);
    expect(await latest()).toBe(vault.toBase58());
    const state = await client.getVault(vault);
    expect(state).toMatchObject({ owner: owner.publicKey, agent: new PublicKey(deployment.agent), maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, spentRaw: 0n });
    const time = BigInt((await connection.getBlockTime(await connection.getSlot("confirmed")))!);
    expect(state.expiryUnix - time).toBeGreaterThan(3500n); expect(state.expiryUnix - time).toBeLessThanOrEqual(3600n);
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => fetcher(typeof input === "string" && input.startsWith("/api/") ? `${url}${input}` : input, init));
    try {
      const dashboard = await connectWalletDashboard("localnet", { publicKey: owner.publicKey, signTransaction: async () => { throw new Error("Discovery must not sign."); } });
      expect(dashboard.initialVault?.equals(vault)).toBe(true);
      expect(await dashboard.client.getVault(dashboard.initialVault!)).toEqual(state);
    } finally { vi.unstubAllGlobals(); }
    expect(await latest(Keypair.generate().publicKey)).toBeNull();
  });

  it("POST fund signs and confirms a testUSDC transfer into that owner's latest vault", async () => {
    await signAndConfirm(await post("fund", "?amount=1000"));
    expect((await client.getVault(vault)).inputBalanceRaw).toBe(1_000_000_000n);
    expect((await getAccount(connection, getAssociatedTokenAddressSync(new PublicKey(deployment.inputMint), owner.publicKey))).amount).toBe(0n);
    // Produce an output balance so Withdraw all must withdraw both mints.
    const response = await fetch(`${url}/api/agent/normal`, { method: "POST", headers: { origin: url, "content-type": "application/json", "x-aegis-agent": "localnet" }, body: JSON.stringify({ live: false, vault: vault.toBase58() }) });
    const steps = (await response.json()).steps;
    expect(steps.find((step: { type: string }) => step.type === "result").result).toMatchObject({ ok: true });
  });

  it("POST revoke signs and confirms owner revocation", async () => {
    await signAndConfirm(await post("revoke"));
    expect((await client.getVault(vault)).revoked).toBe(true);
  });

  it("POST withdraw signs and atomically confirms both withdrawals after revoke, creating the owner's output ATA", async () => {
    const output = getAssociatedTokenAddressSync(new PublicKey(deployment.outputMint), owner.publicKey);
    expect(await connection.getAccountInfo(output)).toBeNull();
    const unsigned = await post("withdraw");
    expect(TransactionMessage.decompile(unsigned.message).instructions).toHaveLength(4);
    await signAndConfirm(unsigned);
    expect(await client.getVault(vault)).toMatchObject({ inputBalanceRaw: 0n, outputBalanceRaw: 0n, revoked: true, spentRaw: 20_000_000n });
    expect((await getAccount(connection, output)).amount).toBe(200_000_000n);
    expect((await getAccount(connection, getAssociatedTokenAddressSync(new PublicKey(deployment.inputMint), owner.publicKey))).amount).toBe(980_000_000n);
    const empty = await fetch(`${url}/api/actions/withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: owner.publicKey.toBase58() }) });
    headers(empty); expect(empty.status).toBe(400); expect((await empty.json()).message).toContain("already empty");
  });

  it("selects the newest confirmed creation, ignoring unsigned proposals and newer activity on an older vault", async () => {
    const next = await post("create", "?cap=25&budget=75");
    const nextVault = TransactionMessage.decompile(next.message).instructions[0].keys[1].pubkey;
    expect(await latest()).toBe(vault.toBase58());
    await signAndConfirm(next);
    expect(await client.revoke(owner, vault)).toMatchObject({ ok: true });
    expect(await latest()).toBe(nextVault.toBase58());
    expect(await client.getVault(nextVault)).toMatchObject({ maxTradeRaw: 25_000_000n, budgetRaw: 75_000_000n, revoked: false });
    await signAndConfirm(await post("fund", "?amount=0.000001"));
    expect((await client.getVault(nextVault)).inputBalanceRaw).toBe(1n);
    expect((await client.getVault(vault)).inputBalanceRaw).toBe(0n);
  });
});
