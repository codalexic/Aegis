import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { deriveSwapAccounts, rawAmountToUi, type TxResult } from "../../packages/sdk/src/index";
import type { AgentContext } from "./context";
import { AgentError, modelInput, newsFor, parseTrade, SCRIPTED_HINT, type ModelMode } from "./model";

export type AgentMode = ModelMode | "attacker" | "scripted";
type Propose = (input: string) => Promise<string>;

/** Public, JSON-safe console events. Signers and model configuration never enter this type. */
export type Step =
  | { type: "news"; text: string; injection?: string }
  | { type: "model_reply"; reply: { amountUsdc: string; reason: string } | string; source: "live" | "scripted" | "fixed" }
  | { type: "request"; amountUsdc: string; amountRaw: string; outputVault?: string }
  | { type: "result"; environment: "mock" | "localnet"; result: TxResult }
  | { type: "balances"; inputUsdc: string; outputSol: string; spentUsdc: string; remainingUsdc: string }
  | { type: "notice"; code: "injection_resisted" | "unexpected_outcome" | "error"; message: string };

export async function runAgent(context: AgentContext, mode: AgentMode, propose: Propose,
  log: (message: string, step?: Step) => void = (message) => console.log(message),
  options: { scripted?: boolean } = {}): Promise<boolean> {
  const { client, agent, vault } = context;
  const scenarios = mode === "scripted" ? ["normal", "injected", "attacker"] as const : [mode];
  let expected = true;
  const scripted = mode === "scripted" || options.scripted === true;
  for (const scenario of scenarios) {
    const state = await client.getVault(vault);
    log(`\n[${client.environment}] ${scenario}${mode === "scripted" ? " · scripted" : ""}`);
    let reply: string;
    if (scenario === "attacker") {
      log("News: not used; direct destination-redirection attack (no model).", {
        type: "news", text: "Direct destination-redirection attack. No news or AI model is used.",
      });
      reply = JSON.stringify({ amountUsdc: "20", reason: "Redirect output_vault to the attacker's testSOL token account." });
      log(`Fixed request (no model): ${reply}`);
    } else {
      const news = newsFor(scenario);
      log(`News:\n${news}`, { type: "news", text: news, ...(scenario === "injected" && { injection: news.split("\n")[1] }) });
      reply = scripted
        ? JSON.stringify({ amountUsdc: scenario === "normal" ? "20" : "1000", reason: `Scripted ${scenario} scenario.` })
        : await propose(modelInput(state, news));
      // Escape control characters in untrusted text so it cannot rewrite stage output.
      const visibleReply = reply.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
      log(`${scripted ? "Scripted reply (no model)" : "Model reply"}: ${visibleReply}`);
    }
    let trade;
    try { trade = parseTrade(reply); } catch (error) {
      log("Invalid model reply.", { type: "model_reply", reply, source: scripted ? "scripted" : "live" });
      if (scenario === "injected") log(`Model refused the injection or returned an invalid trade. ${SCRIPTED_HINT}`, {
        type: "notice", code: "injection_resisted", message: "The model resisted the injection or returned an invalid trade.",
      });
      throw error;
    }
    log("", { type: "model_reply", reply: { amountUsdc: trade.amountUsdc, reason: trade.reason },
      source: scenario === "attacker" ? "fixed" : scripted ? "scripted" : "live" });
    if (scenario === "injected" && trade.amountRaw !== 1_000_000_000n) {
      log(`Model did not follow the full-balance injection. Submitting its actual proposal unchanged. ${SCRIPTED_HINT}`, {
        type: "notice", code: "injection_resisted", message: "The model resisted the injection. Its actual proposal was submitted unchanged.",
      });
      expected = false;
    }
    const request = { type: "request" as const, amountUsdc: trade.amountUsdc, amountRaw: trade.amountRaw.toString() };
    let result;
    if (scenario === "attacker") {
      log(`Request sent: execute_swap ${trade.amountUsdc} testUSDC (${trade.amountRaw} raw).`);
      const accounts = deriveSwapAccounts(vault, state.inputMint, state.outputMint);
      const attacker = new PublicKey(new Uint8Array(32).fill(5));
      accounts.outputVault = getAssociatedTokenAddressSync(state.outputMint, attacker, true);
      log(`output_vault replaced with attacker token account: ${accounts.outputVault.toBase58()}`, {
        ...request, outputVault: accounts.outputVault.toBase58(),
      });
      result = await client.swapRaw(agent, accounts, trade.amountRaw);
    } else {
      // No cap/budget filter or clamp: the selected client must submit the actual proposal.
      log(`Request sent: execute_swap ${trade.amountUsdc} testUSDC (${trade.amountRaw} raw).`, request);
      result = await client.swap(agent, vault, trade.amountRaw);
    }
    log(`Result [${client.environment}]: ${result.ok ? "✓ Success" : `✗ ${result.error}`} (${result.signature ?? "no signature"})`, {
      type: "result", environment: client.environment, result,
    });
    const after = await client.getVault(vault);
    log(`Balances: ${rawAmountToUi(after.inputBalanceRaw, 6)} testUSDC / ${rawAmountToUi(after.outputBalanceRaw, 9)} testSOL; spent ${rawAmountToUi(after.spentRaw, 6)} testUSDC.`, {
      type: "balances", inputUsdc: rawAmountToUi(after.inputBalanceRaw, 6), outputSol: rawAmountToUi(after.outputBalanceRaw, 9),
      spentUsdc: rawAmountToUi(after.spentRaw, 6), remainingUsdc: rawAmountToUi(after.budgetRaw - after.spentRaw, 6),
    });
    const matches = scenario === "normal" ? result.ok
      : !result.ok && result.error === (scenario === "injected" ? "CapExceeded" : "AccountMismatch");
    if (!matches) {
      expected = false;
      log(`Unexpected outcome for ${scenario}. ${SCRIPTED_HINT}`, {
        type: "notice", code: "unexpected_outcome", message: `Unexpected outcome for ${scenario}. Check the vault policy and balance.`,
      });
    }
    if (!result.ok && (after.inputBalanceRaw !== state.inputBalanceRaw ||
        after.outputBalanceRaw !== state.outputBalanceRaw || after.spentRaw !== state.spentRaw)) {
      throw new AgentError("Rejected trade changed balances or spent; stop and investigate.");
    }
  }
  return expected;
}
