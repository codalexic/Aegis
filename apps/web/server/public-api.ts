import type { IncomingMessage, ServerResponse } from "node:http";
import { BLOCKCHAIN_IDS, createActionHeaders } from "@solana/actions";
import { PublicKey } from "@solana/web3.js";
import { AgentError, ModelHttpError, askModel, modelConfig } from "../../../scripts/agent/model";
import { runAgent, type Step } from "../../../scripts/agent/run";
import { actionsMiddleware } from "../api/actions/routes";
import { ActionsService, walletAddress } from "../api/actions/service";
import { ApiError, json, readBody } from "./http";
import { deployment, devnetClient, environmentSigner, mintTestUsdc } from "./devnet-service";
import { FaucetLimiter } from "./faucet-limiter";
import { IpLimiter, vercelIp } from "./public-limits";

export function siteOrigin(env: NodeJS.ProcessEnv): string {
  const host = env.VERCEL_ENV === "production" ? env.VERCEL_PROJECT_PRODUCTION_URL : env.VERCEL_URL;
  try {
    const url = new URL(env.AEGIS_PUBLIC_ORIGIN ?? `https://${host ?? ""}`);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new ApiError(503, "Configure AEGIS_PUBLIC_ORIGIN with the public HTTPS site origin."); }
}

function liveConfig(env: NodeJS.ProcessEnv) {
  try { return modelConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: env.GEMINI_API_KEY, AI_MODEL: env.AI_MODEL }); }
  catch { throw new ApiError(503, "Live AI is unavailable. Check GEMINI_API_KEY and AI_MODEL in Vercel settings, or use Scripted."); }
}

function requireWrite(request: IncomingMessage, env: NodeJS.ProcessEnv, actor: "agent" | "faucet") {
  const origin = request.headers.origin;
  // Origin-less requests support curl. Browser writes must come from the configured site.
  if ((origin !== undefined && origin !== siteOrigin(env)) || request.headers[`x-aegis-${actor}`] !== "devnet") throw new ApiError(403, "Same-origin devnet requests only.");
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new ApiError(415, "Send application/json.");
}

export function createPublicHandler(env: NodeJS.ProcessEnv = process.env) {
  const ips = new IpLimiter();
  const faucet = new FaucetLimiter();
  const activeVaults = new Set<string>();
  let faucetBusy = false;
  const actions = actionsMiddleware(async () => ({
    service: new ActionsService(deployment, devnetClient().connection),
    origin: siteOrigin(env), chainId: BLOCKCHAIN_IDS.devnet,
  }), BLOCKCHAIN_IDS.devnet);
  return async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url?.split("?")[0] ?? "";
    try {
      if (path.startsWith("/api/actions/")) {
        // Headers also survive configuration errors and OPTIONS needs no RPC or keys.
        for (const [key, value] of Object.entries(createActionHeaders({ chainId: BLOCKCHAIN_IDS.devnet, actionVersion: "2.4.1" }))) response.setHeader(key, value);
        if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
        await new Promise<void>((resolve) => {
          response.once("finish", resolve);
          response.once("close", resolve);
          actions(request, response, () => { json(response, 404, { message: "Unknown action." }); });
        });
        return;
      }
      if (path === "/api/deployment" || path === "/api/agent/info") {
        if (request.method !== "GET") throw new ApiError(405, "Use GET for this endpoint.");
        if (path === "/api/deployment") return json(response, 200, deployment);
        let model: string | null = null;
        try { model = liveConfig(env).model; } catch { /* Scripted remains available. */ }
        return json(response, 200, { environment: "devnet", agent: deployment.agent, model });
      }
      const action = path.slice("/api/agent/".length);
      const isAgent = path.startsWith("/api/agent/") && ["normal", "injected", "attacker"].includes(action);
      if (!isAgent && path !== "/api/faucet") throw new ApiError(404, "Endpoint not found.");
      if (request.method !== "POST") throw new ApiError(405, "Use POST for this endpoint.");
      const actor = isAgent ? "agent" : "faucet";
      requireWrite(request, env, actor);
      ips.take(vercelIp(request), actor);
      const body = await readBody(request);
      if (!isAgent) {
        let recipient: PublicKey;
        try {
          if (Object.keys(body).length !== 1) throw new Error();
          recipient = walletAddress(body.wallet);
        } catch { throw new ApiError(400, "Expected only a valid wallet address."); }
        if (faucetBusy) throw new ApiError(409, "A faucet claim is pending. Wait before retrying.");
        faucet.take(recipient.toBase58());
        faucetBusy = true;
        try { return json(response, 200, await mintTestUsdc(env, recipient)); }
        catch (error) {
          if (error instanceof ApiError && error.status === 429) faucet.release(recipient.toBase58());
          throw error;
        }
        finally { faucetBusy = false; }
      }
      let vault: PublicKey;
      try {
        if (Object.keys(body).length !== 2 || typeof body.live !== "boolean" || typeof body.vault !== "string" || body.vault.length > 44) throw new Error();
        vault = new PublicKey(body.vault);
      } catch { throw new ApiError(400, "Expected only live (boolean) and vault (public address)."); }
      const address = vault.toBase58();
      if (activeVaults.has(address)) throw new ApiError(409, "An agent request for this vault is already running.");
      activeVaults.add(address);
      const steps: Step[] = [];
      try {
        const agent = environmentSigner(env, "AEGIS_AGENT_SECRET", deployment.agent);
        const client = devnetClient();
        const state = await client.getVault(vault);
        if (!state.agent.equals(agent.publicKey)) throw new ApiError(403, "This vault does not authorize the server's agent.");
        const config = body.live && action !== "attacker" ? liveConfig(env) : undefined;
        await runAgent({ client, agent, vault }, action as "normal" | "injected" | "attacker", async (input) => {
          if (!config) throw new ApiError(503, "Live AI is unavailable. Use Scripted.");
          return askModel(config, input);
        }, (_message, step) => { if (step) steps.push(step); }, { scripted: !body.live });
        return json(response, 200, { steps });
      } catch (error) {
        if (error instanceof ModelHttpError) {
          const quota = error.status === 429;
          return json(response, quota ? 429 : 503, { error: quota ? "Gemini quota exceeded (HTTP 429). Use Scripted or try again later."
            : `Gemini returned HTTP ${error.status}. Use Scripted or try again later.`, scriptedAvailable: true });
        }
        if (error instanceof ApiError) throw error;
        if (error instanceof AgentError) {
          // AgentError messages are internal fixed text; never serialize provider bodies/config.
          steps.push({ type: "notice", code: "error", message: "The AI could not produce a valid trade. Use Scripted or try again later." });
          return json(response, 200, { steps, scriptedAvailable: true });
        }
        throw error;
      } finally { activeVaults.delete(address); }
    } catch (error) {
      if (error instanceof ApiError && error.retryAfter !== undefined) response.setHeader("retry-after", String(error.retryAfter));
      json(response, error instanceof ApiError ? error.status : 503, {
        error: error instanceof ApiError ? error.message : "Devnet request could not be confirmed. Check the vault or token balance before retrying.",
      });
    }
  };
}
