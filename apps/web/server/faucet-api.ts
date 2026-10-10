import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import type { Connect, Plugin } from "vite";
import { AnchorAegisClient, type ChainDeployment } from "../../../packages/sdk/src/index";
import { ApiError, json, readBody, requireDashboardRequest } from "./owner-api";

import { FaucetLimiter } from "./faucet-limiter";
export { FaucetLimiter } from "./faucet-limiter";

export async function loadDeployment(root: string, environment: "localnet" | "devnet") {
  let deployment: ChainDeployment;
  try { deployment = JSON.parse(await readFile(join(root, `deployments/${environment}.json`), "utf8")); }
  catch { throw new ApiError(503, `No ${environment} deployment. Run pnpm ${environment === "devnet" ? "devnet:deploy" : "localnet"} first.`); }
  if (deployment.environment !== environment) throw new ApiError(503, "Deployment environment mismatch.");
  const client = new AnchorAegisClient({ deployment });
  return { deployment, client };
}

export function faucetApiMiddleware(root: string, environment: "localnet" | "devnet", limiter = new FaucetLimiter()): Connect.NextHandleFunction {
  return (request, response, next) => {
    const path = request.url?.split("?")[0];
    if (path !== "/api/faucet" && path !== "/api/deployment") return next();
    void (async () => {
      const read = path === "/api/deployment";
      requireDashboardRequest(request, !read, "faucet", environment);
      if (request.method !== (read ? "GET" : "POST")) throw new ApiError(405, "Method not allowed.");
      const { deployment, client } = await loadDeployment(root, environment);
      if (read) {
        const { rpcUrl, wsUrl, inputMint, outputMint, pool, poolAuthority, inputReserve, outputReserve, ownerInput, ownerOutput } = deployment;
        return json(response, 200, { environment, rpcUrl, wsUrl, inputMint, outputMint, pool, poolAuthority, inputReserve, outputReserve, ownerInput, ownerOutput,
          programs: { aegis: deployment.programs.aegis, demoDex: deployment.programs.demoDex },
          owner: new PublicKey(deployment.owner).toBase58(), agent: new PublicKey(deployment.agent).toBase58() });
      }
      const body = await readBody(request);
      let recipient: PublicKey;
      try {
        if (Object.keys(body).length !== 1 || typeof body.wallet !== "string") throw new Error();
        recipient = new PublicKey(body.wallet);
        if (!PublicKey.isOnCurve(recipient.toBytes())) throw new Error();
      } catch { throw new ApiError(400, "Expected only a valid wallet address."); }
      limiter.take(recipient.toBase58());
      let authority: Keypair;
      try {
        const name = environment === "devnet" ? "devnet-deployer" : "owner";
        const bytes: unknown = JSON.parse(await readFile(join(root, `.keys/${name}.json`), "utf8"));
        if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
        authority = Keypair.fromSecretKey(Uint8Array.from(bytes));
        if (authority.publicKey.toBase58() !== deployment.owner) throw new Error();
      } catch { throw new ApiError(503, "Faucet authority is unavailable. Check the server configuration."); }
      const mint = new PublicKey(deployment.inputMint);
      const state = await getMint(client.connection, mint, "confirmed");
      if (state.decimals !== 6 || !state.mintAuthority?.equals(authority.publicKey)) throw new ApiError(503, "Faucet mint configuration mismatch.");
      const destination = getAssociatedTokenAddressSync(mint, recipient);
      const transaction = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, destination, recipient, mint),
        createMintToCheckedInstruction(mint, destination, authority.publicKey, 1_000_000_000n, 6),
      );
      const signature = await sendAndConfirmTransaction(client.connection, transaction, [authority], { commitment: "confirmed" });
      json(response, 200, { signature, amountRaw: "1000000000" });
    })().catch((error: unknown) => json(response, error instanceof ApiError ? error.status : 503,
      { error: error instanceof ApiError ? error.message : "Faucet request could not be confirmed. Check your token balance before retrying later." }));
  };
}

export function faucetApiPlugin(root: string, environment: "localnet" | "devnet"): Plugin {
  return { name: "aegis-wallet-faucet", apply: "serve", configureServer(server) {
    server.middlewares.use(faucetApiMiddleware(root, environment));
  } };
}
