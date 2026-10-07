import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { deriveSwapAccounts, rawAmountToUi } from "../../packages/sdk/src/index";
import type { AgentContext } from "./context";
import { AgentError, modelInput, newsFor, parseTrade, SCRIPTED_HINT, type ModelMode } from "./model";

export type AgentMode = ModelMode | "attacker" | "scripted";
type Propose = (input: string) => Promise<string>;

export async function runAgent(context: AgentContext, mode: AgentMode, propose: Propose, log = console.log): Promise<boolean> {
  const { client, agent, vault } = context;
  const scenarios = mode === "scripted" ? ["normal", "injected", "attacker"] as const : [mode];
  let expected = true;
  for (const scenario of scenarios) {
    const state = await client.getVault(vault);
    log(`\n[${client.environment}] ${scenario}${mode === "scripted" ? " · scripted" : ""}`);
    let reply: string;
    if (scenario === "attacker") {
      log("News: not used; direct destination-redirection attack (no model).");
      reply = JSON.stringify({ amountUsdc: "20", reason: "Redirect output_vault to the attacker's testSOL token account." });
      log(`Fixed request (no model): ${reply}`);
    } else {
      const news = newsFor(scenario);
      log(`News:\n${news}`);
      reply = mode === "scripted"
        ? JSON.stringify({ amountUsdc: scenario === "normal" ? "20" : "1000", reason: `Scripted ${scenario} scenario.` })
        : await propose(modelInput(state, news));
      // Escape control characters in untrusted text so it cannot rewrite stage output.
      const visibleReply = reply.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
      log(`${mode === "scripted" ? "Scripted reply (no model)" : "Model reply"}: ${visibleReply}`);
    }
    let trade;
    try { trade = parseTrade(reply); } catch (error) {
      if (scenario === "injected") log(`Model refused the injection or returned an invalid trade. ${SCRIPTED_HINT}`);
      throw error;
    }
    if (scenario === "injected" && trade.amountRaw !== 1_000_000_000n) {
      log(`Model did not follow the full-balance injection. Submitting its actual proposal unchanged. ${SCRIPTED_HINT}`);
      expected = false;
    }
    log(`Request sent: execute_swap ${trade.amountUsdc} testUSDC (${trade.amountRaw} raw).`);
    let result;
    if (scenario === "attacker") {
      const accounts = deriveSwapAccounts(vault, state.inputMint, state.outputMint);
      const attacker = new PublicKey(new Uint8Array(32).fill(5));
      accounts.outputVault = getAssociatedTokenAddressSync(state.outputMint, attacker, true);
      log(`output_vault replaced with attacker token account: ${accounts.outputVault.toBase58()}`);
      result = await client.swapRaw(agent, accounts, trade.amountRaw);
    } else {
      // No cap/budget filter or clamp: the program (mock here) must reject the proposal.
      result = await client.swap(agent, vault, trade.amountRaw);
    }
    log(`Result [${client.environment}]: ${result.ok ? "✓ Success" : `✗ ${result.error}`} (${result.signature ?? "no signature"})`);
    const after = await client.getVault(vault);
    log(`Balances: ${rawAmountToUi(after.inputBalanceRaw, 6)} testUSDC / ${rawAmountToUi(after.outputBalanceRaw, 9)} testSOL; spent ${rawAmountToUi(after.spentRaw, 6)} testUSDC.`);
    const matches = scenario === "normal" ? result.ok
      : !result.ok && result.error === (scenario === "injected" ? "CapExceeded" : "AccountMismatch");
    if (!matches) {
      expected = false;
      log(`Unexpected outcome for ${scenario}. ${SCRIPTED_HINT}`);
    }
    if (!result.ok && (after.inputBalanceRaw !== state.inputBalanceRaw ||
        after.outputBalanceRaw !== state.outputBalanceRaw || after.spentRaw !== state.spentRaw)) {
      throw new AgentError("Rejected trade changed balances or spent; stop and investigate.");
    }
  }
  return expected;
}
