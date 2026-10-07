import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ChainDeployment } from "../../../packages/sdk/src/anchor";
import { connectWalletDashboard } from "../src/wallet-client";
import { faucetApiMiddleware } from "../server/faucet-api";
import { agentApiMiddleware } from "../server/agent-api";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let server: Server, url: string, deployment: ChainDeployment, connection: Connection;
const owner = Keypair.generate(); // Ephemeral automated wallet; private material stays in this Node process.
const signTransaction = vi.fn(async (transaction: VersionedTransaction) => {
  const signed = VersionedTransaction.deserialize(transaction.serialize());
  signed.sign([owner]);
  return signed;
});
const realFetch = globalThis.fetch;
beforeAll(async () => {
  deployment = JSON.parse(await readFile(`${root}/deployments/localnet.json`, "utf8"));
  expect(deployment.environment).toBe("localnet");
  expect(new URL(deployment.rpcUrl).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  connection = new Connection(deployment.rpcUrl, "confirmed");
  const signature = await connection.requestAirdrop(owner.publicKey, 1_000_000_000);
  await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash("confirmed") }, "confirmed");
  const faucet = faucetApiMiddleware(root, "localnet"), agent = agentApiMiddleware(root, "localnet", true);
  server = createServer((req, res) => faucet(req, res, () => agent(req, res, () => res.writeHead(404).end())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  url = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/api/")) return realFetch(`${url}${input}`, { ...init, headers: { ...init?.headers, origin: url } });
    return realFetch(input, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("uses a mock wallet signer and the actual local mint through the complete owner and three-agent-button flow", async () => {
  const dashboard = await connectWalletDashboard("localnet", { publicKey: owner.publicKey, signTransaction });
  expect(dashboard.owner.equals(owner.publicKey)).toBe(true);
  expect(dashboard.agent.toBase58()).toBe(deployment.agent);
  const inputMint = new PublicKey(deployment.inputMint), outputMint = new PublicKey(deployment.outputMint);
  const inputAta = getAssociatedTokenAddressSync(inputMint, owner.publicKey);
  expect(await connection.getAccountInfo(inputAta)).toBeNull();
  await expect(dashboard.faucet!()).resolves.toContain("Received 1,000 testUSDC");
  expect((await getAccount(connection, inputAta)).amount).toBe(1_000_000_000n);
  await expect(dashboard.faucet!()).rejects.toThrow("once per 10 minutes");
  expect((await getAccount(connection, inputAta)).amount).toBe(1_000_000_000n);
  expect(signTransaction).not.toHaveBeenCalled(); // Only the server mint authority signs the faucet.

  const created = await dashboard.newDemo();
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true, vault: expect.any(PublicKey), createSignature: expect.any(String) });
  const vault = created.vault!;
  expect(signTransaction).toHaveBeenCalledTimes(2);
  expect(await dashboard.client.getVault(vault)).toMatchObject({ owner: owner.publicKey, agent: dashboard.agent, inputBalanceRaw: 1_000_000_000n, spentRaw: 0n });

  for (const [action, error] of [["normal", undefined], ["injected", "CapExceeded"], ["attacker", "AccountMismatch"]] as const) {
    const before = await dashboard.client.getVault(vault);
    const response = await fetch(`${url}/api/agent/${action}`, { method: "POST", headers: { origin: url, "content-type": "application/json", "x-aegis-agent": "localnet" }, body: JSON.stringify({ live: false, vault: vault.toBase58() }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    const result = body.steps.find((step: { type: string }) => step.type === "result")?.result;
    expect(result, JSON.stringify(body)).toMatchObject(error ? { ok: false, origin: "program", error, signature: expect.any(String) } : { ok: true, signature: expect.any(String) });
    if (error) expect(await dashboard.client.getVault(vault)).toEqual(before);
    expect(JSON.stringify(body)).not.toMatch(/secretKey|AIza/);
  }
  expect(signTransaction).toHaveBeenCalledTimes(2); // Agent scenarios use the server agent only.
  const traded = await dashboard.client.getVault(vault);
  expect(traded).toMatchObject({ inputBalanceRaw: 980_000_000n, outputBalanceRaw: 200_000_000n, spentRaw: 20_000_000n });
  expect(await dashboard.revoke(vault)).toMatchObject({ ok: true });
  expect((await dashboard.client.getVault(vault)).revoked).toBe(true);
  expect(await dashboard.withdraw(vault, inputMint, traded.inputBalanceRaw)).toMatchObject({ ok: true });
  expect(await dashboard.withdraw(vault, outputMint, traded.outputBalanceRaw)).toMatchObject({ ok: true });
  expect(signTransaction).toHaveBeenCalledTimes(5);
  expect(await dashboard.client.getVault(vault)).toMatchObject({ inputBalanceRaw: 0n, outputBalanceRaw: 0n, revoked: true });
  expect((await getAccount(connection, inputAta)).amount).toBe(980_000_000n);
  expect((await getAccount(connection, getAssociatedTokenAddressSync(outputMint, owner.publicKey))).amount).toBe(200_000_000n);
  expect(await dashboard.client.listActivity(vault)).toHaveLength(8);
});
