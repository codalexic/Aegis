import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import type { Plugin } from "vite";
import type { ChainDeployment } from "../../../../packages/sdk/src/anchor";
import { devnetFetch } from "../../../../packages/sdk/src/rpc-fetch";
import { ActionError, ActionsService } from "./service";
import { actionsMiddleware } from "./routes";

export function actionsPlugin(root: string, environment: string, options: { deploymentPath?: string; origin?: string } = {}): Plugin {
  return { name: "aegis-actions", apply: "serve",
    // Vite installs CORS before plugin routes. Let OPTIONS reach our scoped
    // Actions handler while retaining Vite's default allowed origins elsewhere.
    config: () => ({ server: { cors: { preflightContinue: true } } }),
    configureServer(server) {
    server.middlewares.use(actionsMiddleware(async () => {
      let deployment: ChainDeployment;
      try { deployment = JSON.parse(await readFile(resolve(root, options.deploymentPath ?? `deployments/${environment}.json`), "utf8")); }
      catch { throw new ActionError(503, "No Actions deployment configured. Start localnet or deploy the selected cluster first."); }
      const endpoint = new URL(deployment.rpcUrl);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new ActionError(503, "Invalid Actions RPC configuration.");
      const origin = options.origin ?? server.resolvedUrls?.local[0];
      if (!origin || !["http:", "https:"].includes(new URL(origin).protocol)) throw new ActionError(503, "Configure an HTTP(S) Actions site origin.");
      const connection = new Connection(deployment.rpcUrl, { commitment: "confirmed", fetch: devnetFetch(), disableRetryOnRateLimit: true });
      const service = new ActionsService(deployment, connection);
      const genesis = await connection.getGenesisHash();
      return { service, origin, chainId: `solana:${genesis.slice(0, 32)}` };
    }));
  } };
}
