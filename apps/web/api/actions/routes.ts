import { createActionHeaders, type ActionGetResponse } from "@solana/actions";
import type { Connect } from "vite";
import rules from "../../public/actions.json";
import { ApiError, json, readBody } from "../../server/owner-api";
import { ActionError, ActionsService, walletAddress, type ActionName } from "./service";

export interface ActionsConfig {
  service: ActionsService;
  /** Canonical site URL from configuration, never a caller-controlled Host header. */
  origin: string;
  /** CAIP-2 ID from the configured RPC's genesis hash, including local validators. */
  chainId: string;
}
const names: Record<ActionName, string> = { create: "Create Aegis vault", fund: "Fund vault", revoke: "Revoke agent", withdraw: "Withdraw all" };
const fields: Record<ActionName, string[]> = { create: ["cap", "budget"], fund: ["amount"], revoke: [], withdraw: [] };

function metadata(action: ActionName, config: ActionsConfig): ActionGetResponse {
  const path = `/api/actions/${action}`;
  const parameters = action === "create" ? [
    { name: "cap", label: "Per-trade cap in testUSDC (default 50)" },
    { name: "budget", label: "Total budget in testUSDC (default 100)" },
  ] : action === "fund" ? [{ name: "amount", label: "Amount of testUSDC", required: true }] : [];
  const query = parameters.map(({ name }) => `${name}={${name}}`).join("&");
  const description = action === "create" ? "Create a vault with the configured trading agent, your chosen limits and a one-hour expiry. Defaults: cap 50, budget 100 testUSDC."
    : action === "fund" ? "Transfer testUSDC from your wallet to your latest confirmed vault."
    : action === "revoke" ? "Revoke the trading agent for your latest confirmed vault. You can still withdraw."
    : "Withdraw both token balances from your latest confirmed vault to your wallet, including after revocation or expiry.";
  return { type: "action", title: names[action], label: names[action], icon: new URL("/aegis.png", config.origin).href,
    description: `${description} Cluster: ${config.service.deployment.environment}. Test tokens only.`,
    links: { actions: [{ type: "transaction", label: names[action], href: `${path}${query ? `?${query}` : ""}`,
      ...(parameters.length && { parameters: parameters.map((parameter) => ({ ...parameter, type: "text" as const,
        pattern: "^[0-9]+(\\.[0-9]{1,6})?$", patternDescription: "Positive decimal testUSDC amount, up to 6 decimal places." })) }) }] } };
}

/** Actions are cross-origin unsigned builders; existing key-backed APIs keep their own stricter boundary. */
export function actionsMiddleware(loadConfig: () => Promise<ActionsConfig>): Connect.NextHandleFunction {
  return (request, response, next) => {
    const path = request.url?.split("?")[0];
    if (path !== "/actions.json" && !path?.startsWith("/api/actions/")) return next();
    for (const [key, value] of Object.entries(createActionHeaders({ actionVersion: "2.4.1" }))) response.setHeader(key, value);
    void (async () => {
      const config = await loadConfig();
      for (const [key, value] of Object.entries(createActionHeaders({ chainId: config.chainId, actionVersion: "2.4.1" }))) response.setHeader(key, value);
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url!, config.origin);
      if (path === "/actions.json") {
        if (request.method !== "GET") throw new ActionError(405, "Use GET to read actions.json.");
        return json(response, 200, rules);
      }
      if (path === "/api/actions/latest-vault") {
        if (request.method !== "GET") throw new ActionError(405, "Use GET to find the latest vault.");
        if ([...url.searchParams.keys()].some((key) => key !== "account") || url.searchParams.getAll("account").length !== 1) throw new ActionError(400, "Provide only the wallet account.");
        const vault = await config.service.latestVault(walletAddress(url.searchParams.get("account")));
        return json(response, 200, { vault: vault?.toBase58() ?? null });
      }
      const action = path!.slice("/api/actions/".length) as ActionName;
      if (!Object.hasOwn(names, action)) throw new ActionError(404, "Unknown Aegis action.");
      if (request.method === "GET") return json(response, 200, metadata(action, config));
      if (request.method !== "POST") throw new ActionError(405, "Use GET, POST or OPTIONS for this action.");
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new ActionError(415, "POST a JSON object containing account.");
      const body = await readBody(request);
      if (Object.keys(body).some((key) => !["account", "data", "type"].includes(key))) throw new ActionError(400, "Unexpected action request fields.");
      if (body.type !== undefined && body.type !== "transaction") throw new ActionError(400, "This action returns a transaction.");
      const owner = walletAddress(body.account);
      if (body.data !== undefined && (!body.data || typeof body.data !== "object" || Array.isArray(body.data))) throw new ActionError(400, "Action data must be an object.");
      const values: Record<string, unknown> = { ...(body.data as Record<string, unknown> | undefined) };
      for (const [key, value] of url.searchParams) {
        if (!fields[action].includes(key)) throw new ActionError(400, "Unexpected action parameters.");
        if (Object.hasOwn(values, key)) throw new ActionError(400, "Duplicate action parameter.");
        values[key] = value;
      }
      if (Object.keys(values).some((key) => !fields[action].includes(key))) throw new ActionError(400, "Unexpected action parameters.");
      return json(response, 200, await config.service.build(action, owner, values));
    })().catch((error: unknown) => {
      const controlled = error instanceof ActionError || error instanceof ApiError;
      json(response, controlled ? error.status : 503, { message: controlled ? error.message : "Action unavailable. Check the configured deployment and RPC, then try again." });
    });
  };
}
