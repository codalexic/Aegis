import { readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
// A relative import lets Vite bundle the workspace's TypeScript SDK into its Node config.
import { AnchorAegisClient, deriveVaultPda, parseRawAmount, type LocalnetDeployment } from "../../../packages/sdk/src/index";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connect, Plugin } from "vite";

import { ApiError, json, readBody } from "./http";
export { ApiError, json, readBody } from "./http";

/** Signing is restricted to requests from this loopback dashboard, including before Vite's own middleware. */
export function requireDashboardRequest(request: IncomingMessage, write: boolean, actor: "owner" | "agent" | "faucet" = "owner", environment = "localnet") {
  const peer = request.socket.remoteAddress;
  const host = request.headers.host;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
      !host || !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
      new URL(`http://${host}`).port !== String(request.socket.localPort)) throw new ApiError(403, "Loopback dashboard requests only.");
  if (write && (request.headers.origin !== `http://${host}` || request.headers[`x-aegis-${actor}`] !== environment ||
      request.headers["content-type"]?.split(";")[0] !== "application/json")) throw new ApiError(403, "Same-origin dashboard JSON requests only.");
}

async function loadOwner(root: string, expected: string) {
  try {
    const bytes: unknown = JSON.parse(await readFile(join(root, ".keys/owner.json"), "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
    const owner = Keypair.fromSecretKey(Uint8Array.from(bytes));
    if (owner.publicKey.toBase58() !== expected) throw new Error();
    return owner;
  } catch { throw new ApiError(503, "Cannot load the localnet owner test key; run pnpm localnet."); }
}

export function ownerApiMiddleware(root: string): Connect.NextHandleFunction {
  let busy = false;
  const deploymentPath = join(root, "deployments/localnet.json");
  return (request, response, next) => {
    const path = request.url?.split("?")[0];
    if (path !== "/api/localnet" && !path?.startsWith("/api/owner/")) return next();
    void (async () => {
      const read = path === "/api/localnet";
      requireDashboardRequest(request, !read);
      if (request.method !== (read ? "GET" : "POST")) throw new ApiError(405, "Method not allowed.");
      const action = path?.slice("/api/owner/".length);
      if (!read && !["create", "new-demo", "fund", "revoke", "withdraw"].includes(action ?? "")) throw new ApiError(404, "Unknown owner action.");
      if (!read && busy) throw new ApiError(409, "An owner action is already running.");
      if (!read) busy = true;
      try {
        const deployment: LocalnetDeployment & { lastVault?: string } = JSON.parse(await readFile(deploymentPath, "utf8"));
        const client = new AnchorAegisClient({ deployment });
        const ownerAddress = new PublicKey(deployment.owner);
        const agentAddress = new PublicKey(deployment.agent);
        const vault = deployment.lastVault ? new PublicKey(deployment.lastVault) : deriveVaultPda(ownerAddress, 0n)[0];
        if (read) {
          // Project only public deployment fields. No key-file or environment contents reach the browser.
          const { environment, rpcUrl, wsUrl, inputMint, outputMint, pool, poolAuthority, inputReserve, outputReserve, ownerInput, ownerOutput } = deployment;
          return json(response, 200, { environment, rpcUrl, wsUrl, inputMint, outputMint, pool, poolAuthority, inputReserve, outputReserve,
            ownerInput, ownerOutput, programs: { aegis: deployment.programs.aegis, demoDex: deployment.programs.demoDex },
            owner: ownerAddress.toBase58(), agent: agentAddress.toBase58(), lastVault: vault.toBase58() });
        }
        const body = await readBody(request);
        const allowed = action === "withdraw" ? ["mint", "amountRaw"] : [];
        if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ApiError(400, "Unexpected request fields.");
        const owner = await loadOwner(root, deployment.owner);
        if (action === "create" || action === "new-demo") {
          const chainTime = await client.connection.getBlockTime(await client.connection.getSlot("confirmed"));
          if (chainTime === null) throw new ApiError(503, "Localnet clock is unavailable.");
          const result = await client.createVault(owner, {
            vaultId: action === "new-demo" ? randomBytes(8).readBigUInt64LE() | 1n : 0n,
            agent: agentAddress, maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: BigInt(chainTime) + 3600n,
          });
          if (result.ok && result.vault) {
            const temporary = `${deploymentPath}.tmp`;
            await writeFile(temporary, `${JSON.stringify({ ...deployment, lastVault: result.vault.toBase58() }, null, 2)}\n`);
            await rename(temporary, deploymentPath);
            if (action === "new-demo") {
              // Keep a created vault selected even if funding fails, so the owner can retry funding it.
              let funding;
              try { funding = await client.fundVault(owner, result.vault, 1_000_000_000n); }
              catch { funding = { ok: false, error: "Localnet funding request failed", origin: "rpc" }; }
              return json(response, 200, { ...funding, vault: result.vault.toBase58(), createSignature: result.signature,
                ...(!funding.ok && { error: `Vault created, but funding failed: ${funding.error}. Use Fund 1,000 to retry.` }) });
            }
          }
          return json(response, 200, { ...result, ...(result.vault && { vault: result.vault.toBase58() }) });
        }
        if (action === "fund") return json(response, 200, await client.fundVault(owner, vault, 1_000_000_000n));
        if (action === "revoke") return json(response, 200, await client.revoke(owner, vault));
        let mint: PublicKey;
        let amount: bigint;
        try {
          if (typeof body.mint !== "string" || typeof body.amountRaw !== "string") throw new Error();
          mint = new PublicKey(body.mint);
          amount = parseRawAmount(body.amountRaw);
          if (amount === 0n) throw new Error();
        } catch { throw new ApiError(400, "Expected a mint and a positive raw decimal-string amount."); }
        return json(response, 200, await client.withdraw(owner, vault, mint, amount));
      } finally { if (!read) busy = false; }
    })().catch((error: unknown) => {
      // JSON/key/RPC exceptions may include private contents; only controlled messages are returned.
      json(response, error instanceof ApiError ? error.status : 503,
        { error: error instanceof ApiError ? error.message : "Localnet request failed; check that pnpm localnet is running." });
    });
  };
}

export function ownerApiPlugin(root: string): Plugin {
  return { name: "aegis-localnet-owner", apply: "serve", configureServer(server) {
    server.middlewares.use(ownerApiMiddleware(root));
  } };
}
