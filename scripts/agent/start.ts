import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { createMockContext, loadLocalnetAgent } from "./context";
import { AgentError, askModel, modelConfig, SCRIPTED_HINT } from "./model";
import { runAgent } from "./run";

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      mode: { type: "string", default: "normal" }, vault: { type: "string" }, help: { type: "boolean" },
    }, strict: true }));
  } catch { throw new AgentError("Usage: pnpm agent --mode normal|injected|attacker|scripted [--vault ADDRESS]"); }
  if (values.help) {
    console.log("Usage: pnpm agent --mode normal|injected|attacker|scripted [--vault ADDRESS]\nAEGIS_ENV=mock (default). AI_PROVIDER=gemini|anthropic|openai, AI_MODEL optional; provider keys in .env.\nMock runs create a fresh funded vault, separate from the dashboard. Localnet integration follows in C4.");
    return;
  }
  const mode = values.mode;
  if (mode !== "normal" && mode !== "injected" && mode !== "attacker" && mode !== "scripted") {
    throw new AgentError("Unknown mode; use normal, injected, attacker or scripted.");
  }
  try { loadEnvFile(new URL("../../.env", import.meta.url)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentError("Could not load .env.");
  }
  const environment = process.env.AEGIS_ENV ?? "mock";
  if (environment !== "mock" && environment !== "localnet") throw new AgentError("AEGIS_ENV must be mock or localnet.");
  if (environment === "localnet") {
    await loadLocalnetAgent(values.vault);
    throw new AgentError("Localnet agent integration is task C4. Use AEGIS_ENV=mock for C2.");
  }
  const context = await createMockContext(values.vault);
  console.log(`[mock] Aegis agent · ${mode}\nFresh demo vault: ${context.vault.toBase58()}\nFunded 1,000 testUSDC · cap 50 · budget 100 · expiry +1h.\nSimulated transactions; this session is separate from the dashboard.`);
  const config = mode === "normal" || mode === "injected" ? modelConfig(process.env) : undefined;
  if (config) console.log(`AI: ${config.provider} / ${config.model}`);
  const passed = await runAgent(context, mode, async (input) => {
    if (!config) throw new AgentError("No model configured for this mode.");
    return askModel(config, input);
  });
  if (!passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  // Only our controlled errors are printed; SDK/JSON/network exceptions may contain secrets.
  console.error(error instanceof AgentError ? error.message : "Agent failed unexpectedly; check the local configuration.");
  console.error(SCRIPTED_HINT);
  process.exitCode = 1;
});
