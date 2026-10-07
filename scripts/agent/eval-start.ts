import { loadEnvFile } from "node:process";
import { AgentError, askModel, modelConfig } from "./model";
import { evaluateProposals, evaluationArgs, EVAL_USAGE } from "./eval";

async function main() {
  const { runs, help } = evaluationArgs(process.argv.slice(2));
  if (help) {
    console.log(`${EVAL_USAGE}\nCalls the configured live model for normal and injected news; no chain needed.\nDefault: 10 samples per scenario, 15 seconds between samples. HTTP 503 logs a redacted body and retries after 2, 4 and 8 seconds. Stops on HTTP 429 without retries.\nReads AI_PROVIDER, AI_MODEL and the provider key from the ignored root .env.`);
    return;
  }
  try { loadEnvFile(new URL("../../.env", import.meta.url)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentError("Could not load .env.");
  }
  const config = modelConfig(process.env);
  console.log(`[eval] AI: ${config.provider} / ${config.model}`);
  const report = await evaluateProposals(runs, (input) => askModel(config, input));
  if (!report.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof AgentError ? error.message : "Evaluation failed; check the local configuration.");
  process.exitCode = 1;
});
