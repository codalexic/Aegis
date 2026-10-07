import { join } from "node:path";
import { loadEnvFile } from "node:process";
import type { Connect, Plugin } from "vite";
import { createLocalnetContext } from "../../../scripts/agent/context";
import { AgentError, askModel, modelConfig } from "../../../scripts/agent/model";
import { runAgent, type Step } from "../../../scripts/agent/run";
import { ApiError, json, readBody, requireDashboardRequest } from "./owner-api";

function configuration(root: string) {
  try { loadEnvFile(join(root, ".env")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentError("Could not load the local AI settings. Use Scripted or check the server configuration.");
  }
  return modelConfig(process.env);
}

export function agentApiMiddleware(root: string): Connect.NextHandleFunction {
  let busy = false;
  return (request, response, next) => {
    const path = request.url?.split("?")[0];
    if (!path?.startsWith("/api/agent/")) return next();
    void (async () => {
      const action = path.slice("/api/agent/".length);
      const read = action === "info";
      requireDashboardRequest(request, !read, "agent");
      if (request.method !== (read ? "GET" : "POST")) throw new ApiError(405, "Method not allowed.");
      if (read) {
        // The model ID is the only public setting; never serialize the config or environment.
        try { return json(response, 200, { model: configuration(root).model }); }
        catch { return json(response, 200, { model: null }); }
      }
      if (action !== "normal" && action !== "injected" && action !== "attacker") throw new ApiError(404, "Unknown agent action.");
      const body = await readBody(request);
      if (Object.keys(body).length !== 1 || typeof body.live !== "boolean") throw new ApiError(400, "Expected only a boolean live field.");
      if (busy) throw new ApiError(409, "An agent request is already running. Wait for its result.");
      busy = true;
      const steps: Step[] = [];
      try {
        const context = await createLocalnetContext();
        const config = body.live && action !== "attacker" ? configuration(root) : undefined;
        await runAgent(context, action, async (input) => {
          if (!config) throw new AgentError("Live AI is unavailable. Use Scripted or check the server configuration.");
          return askModel(config, input);
        }, (_message, step) => { if (step) steps.push(step); }, { scripted: !body.live });
      } catch (error) {
        if (action === "injected" && error instanceof AgentError && error.message.startsWith("Model refused")) {
          steps.push({ type: "notice", code: "injection_resisted", message: "The model resisted the injection." });
        }
        steps.push({ type: "notice", code: "error", message: error instanceof AgentError ? error.message
          : "Agent request failed. Check localnet and the vault, or retry with Scripted." });
      } finally { busy = false; }
      json(response, 200, { steps });
    })().catch((error: unknown) => {
      json(response, error instanceof ApiError ? error.status : 503, {
        error: error instanceof ApiError ? error.message : "Agent request failed. Check localnet and try again.",
      });
    });
  };
}

export function agentApiPlugin(root: string): Plugin {
  return { name: "aegis-localnet-agent", apply: "serve", configureServer(server) {
    server.middlewares.use(agentApiMiddleware(root));
  } };
}
