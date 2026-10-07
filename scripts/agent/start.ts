import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { createMockContext, createChainContext } from "./context";
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
    console.log("Usage: pnpm agent --mode normal|injected|attacker|scripted [--vault ADDRESS]\nAEGIS_ENV=mock|localnet|devnet (default mock). AI_PROVIDER=gemini|anthropic|openai, AI_MODEL optional; provider keys in .env.\nMock runs create a fresh funded vault. Chain modes use --vault or lastVault in the selected deployment.");
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
  if (environment !== "mock" && environment !== "localnet" && environment !== "devnet") throw new AgentError("AEGIS_ENV must be mock, localnet or devnet.");
  const context = environment === "mock" ? await createMockContext(values.vault) : await createChainContext(environment, values.vault);
  console.log(`[${environment}] Aegis agent · ${mode}\nVault: ${context.vault.toBase58()}`);
  console.log(environment === "mock" ? "Fresh simulated vault: 1,000 testUSDC · cap 50 · budget 100 · expiry +1h. Separate from the dashboard."
    : environment === "devnet" ? "Devnet test tokens. Transactions use .keys/devnet-agent.json."
    : "Test key · localnet only. Transactions use the agent key and appear in the dashboard's chain activity.");
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
