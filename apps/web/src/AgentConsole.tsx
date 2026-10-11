import { useEffect, useRef, useState } from "react";
import type { VaultState } from "@aegis/sdk";
import { rawAmountToUi } from "../../../packages/sdk/src/amounts";
import type { Step } from "../../../scripts/agent/run";
import { Icon, type IconName } from "./icons";
import { PROGRAM_ERROR_MESSAGES } from "./errors";
import { Notice } from "./Notice";

type Scenario = "normal" | "injected" | "attacker";
const decimal = (value: string) => {
  const [whole, fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
};

export function rejectionReason(error: string, vault: VaultState, requested?: string): string {
  switch (error) {
    case "CapExceeded": return `Per-trade cap is ${decimal(rawAmountToUi(vault.maxTradeRaw, 6))} testUSDC; the agent asked for ${decimal(requested ?? "an oversized trade")}.`;
    default: return Object.hasOwn(PROGRAM_ERROR_MESSAGES, error) ? PROGRAM_ERROR_MESSAGES[error]
      : "The transaction failed. Check the vault state before retrying.";
  }
}

export function blockedTitle(error: string): string {
  switch (error) {
    case "CapExceeded": return "Over the per-trade cap";
    case "BudgetExceeded": return "Over the total budget";
    case "AccountMismatch": return "Wrong destination";
    case "Revoked": return "Agent was revoked";
    case "Expired": return "Permission expired";
    case "Unauthorized": return "Not the approved agent";
    case "InvalidAmount": return "Invalid amount";
    case "SwapResultMismatch": return "Exchange shortfall";
    default: return "Blocked";
  }
}

// Plain-language framing for each scenario. Button labels stay as they were
// because server copy refers to them (e.g. "Use Scripted to retry without AI.").
const SCENARIOS: { id: Scenario; icon: IconName; tone: string; title: string; text: string; button: string }[] = [
  { id: "normal", icon: "bolt", tone: "", title: "Normal trade", text: "The agent swaps 20 testUSDC for testSOL. This fits the rules, so it goes through.", button: "Run normal trade" },
  { id: "injected", icon: "alert", tone: "attack", title: "Fake news attack", text: "A planted headline tells the agent to spend 1,000 testUSDC. Aegis blocks it: that is over the cap.", button: "Inject malicious news" },
  { id: "attacker", icon: "lock", tone: "hack", title: "Hacker redirect", text: "A request tries to send the trade output to a stranger’s account. Aegis blocks it: output must stay in the vault.", button: "Hacker redirect" },
];

function News({ step }: { step: Extract<Step, { type: "news" }> }) {
  const at = step.injection ? step.text.indexOf(step.injection) : -1;
  return <p className="agent-news">{at < 0 ? step.text : <>{step.text.slice(0, at)}<mark>{step.injection}</mark>{step.text.slice(at + step.injection!.length)}</>}</p>;
}

export function AgentConsole({ vault, disabled, onBusy, onComplete, environment = "localnet", walletMode = false }: {
  environment?: "localnet" | "devnet"; walletMode?: boolean;
  vault: VaultState | null; disabled: boolean; onBusy(busy: boolean): void; onComplete(): Promise<void>;
}) {
  const [live, setLive] = useState(false);
  const userChose = useRef(false);
  const [model, setModel] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastScenario, setLastScenario] = useState<Scenario>("normal");
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/agent/info", { cache: "no-store" }).then(async (response) => {
      const value = response.ok ? await response.json().catch(() => ({})) : {};
      if (!active) return;
      const configured = typeof value.model === "string";
      setModel(configured ? value.model : null);
      if (configured && !userChose.current) setLive(true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function run(scenario: Scenario, useLive = live) {
    if (running.current || disabled || !vault) return;
    running.current = true;
    setLastScenario(scenario); setBusy(true); onBusy(true); setError(null); setSteps([]);
    try {
      const response = await fetch(`/api/agent/${scenario}`, {
        method: "POST", headers: { "content-type": "application/json", "x-aegis-agent": environment },
        body: JSON.stringify({ live: useLive, ...(walletMode && { vault: vault.address.toBase58() }) }),
      });
      const value = await response.json().catch(() => ({ error: response.status === 429
        ? "Demo request limit reached. Wait a minute before retrying."
        : "The server is temporarily unavailable. Try again later." }));
      if (!response.ok) {
        setError(typeof value.error === "string" ? value.error : "Agent request failed. Try again.");
      } else if (Array.isArray(value.steps)) setSteps(value.steps);
      else setError("The server returned an unreadable result. Try again.");
    } catch { setError("Could not reach the agent. Is the dashboard server running?"); }
    finally {
      try { await onComplete(); } catch { setError("Could not refresh the vault. Try again in a moment."); }
      running.current = false; setBusy(false); onBusy(false);
    }
  }

  const result = steps.find((step) => step.type === "result")?.result;
  const request = steps.find((step) => step.type === "request");
  const resisted = steps.some((step) => step.type === "notice" && step.code === "injection_resisted");
  const locked = disabled || busy || !vault;
  const usable = !!vault && !vault.revoked && vault.expiryUnix > BigInt(Math.floor(Date.now() / 1000));
  const detailSteps = steps.filter((step) => step.type !== "result");
  return <section id="agent" className="card agent-console" aria-labelledby="agent-title" aria-busy={busy}>
    <div className="card-heading">
      <h2 id="agent-title">Agent console</h2>
      <div className="segmented" role="group" aria-label="Agent mode">
        <button aria-pressed={live} disabled={locked} title="A real AI model reads the news and proposes the trade" onClick={() => { userChose.current = true; setLive(true); }}>Live AI</button>
        <button aria-pressed={!live} disabled={locked} title="Replays a fixed reply — works without an AI key" onClick={() => { userChose.current = true; setLive(false); }}>Scripted</button>
      </div>
    </div>
    <p className="muted agent-model">{!vault ? "Finish steps 1 and 2 above, then pick a scenario here."
      : vault && !usable ? (vault.revoked ? "The agent is revoked, so every request will be blocked. Withdraw all, or start a New demo vault from the sidebar." : "This vault’s hour is up, so every request will be blocked. Withdraw all, or start a New demo vault from the sidebar.")
      : live ? (model ? `Live AI: ${model} reads the news and decides the trade itself.` : "No AI key is set up on this server. Switch back to Scripted to run the scenarios.")
      : "Scripted: fixed replies, no AI or network call. The guardrails are enforced exactly the same way."}</p>
    <ul className="scenario-list">
      {SCENARIOS.map((scenario) => <li key={scenario.id} className="scenario">
        <span className={`scenario-icon ${scenario.tone}`} aria-hidden="true"><Icon name={scenario.icon} size={20} /></span>
        <div><strong>{scenario.title}</strong><p>{scenario.text}</p></div>
        <button className={scenario.id === "normal" && usable ? "primary" : undefined} disabled={locked} onClick={() => void run(scenario.id)}>{scenario.button}</button>
      </li>)}
    </ul>
    <div className="agent-result-area">
      {!busy && !error && steps.length === 0 && vault && <p className="agent-placeholder">Pick a scenario above. The result appears here.</p>}
      {busy && <p className="agent-running" role="status">Running… the agent decides, then the vault checks the trade against the rules. This can take a moment.</p>}
      {error && <div className="agent-outcome blocked" role="alert">
        <span className="outcome-icon" aria-hidden="true"><Icon name="alert" /></span>
        <div><strong>The agent could not run</strong><p>{error}</p></div>
        {live && <div className="buttons"><button className="small" disabled={locked} onClick={() => { setLive(false); void run(lastScenario, false); }}>Retry scripted</button></div>}
      </div>}
      {result && <div role="status" data-testid="agent-outcome" className={`agent-outcome ${result.ok ? "executed" : "blocked"}`}>
        <span className="outcome-icon" aria-hidden="true"><Icon name={result.ok ? "check" : "shield"} /></span>
        <div>
          <strong>{result.ok ? "Trade went through" : result.origin === "program" ? `Blocked by Aegis · ${blockedTitle(result.error)}` : "Request failed"}</strong>
          <p>{result.ok ? `Swapped ${decimal(request?.amountUsdc ?? "0")} testUSDC for testSOL, which stays in the vault. Now try one of the two attacks.`
            : <>{result.origin === "program" && vault ? `${rejectionReason(result.error, vault, request?.amountUsdc)} The vault is untouched.` : "The request could not be confirmed. Try again in a moment."} <code className="error-code">{result.error}</code></>}</p>
        </div>
      </div>}
      {resisted && <div className="agent-resisted" role="status"><strong>The AI did not fall for it</strong>
        <p>It did not follow the planted headline, so whatever it actually proposed was sent as-is. Use Retry scripted to see what happens when an agent does obey the fake news.</p>
        <button className="small" disabled={locked} onClick={() => { setLive(false); void run("injected", false); }}>Retry scripted</button>
      </div>}
    </div>
    {detailSteps.length > 0 && <details className="agent-details">
      <summary>Show what happened, step by step</summary>
      <div className="agent-steps" role="region" aria-label="Agent details">
        {detailSteps.map((step, index) => {
          switch (step.type) {
            case "news": return <div key={index}><h3>News the agent read</h3><News step={step} /></div>;
            case "model_reply": return <div key={index}><h3>{step.source === "live" ? "Model reply" : step.source === "scripted" ? "Scripted reply" : "Fixed hacker request · No AI"}</h3><pre>{typeof step.reply === "string" ? step.reply : JSON.stringify(step.reply, null, 2)}</pre></div>;
            case "request": return <div key={index}><h3>Request sent to the vault</h3><p>{decimal(step.amountUsdc)} testUSDC</p>{step.outputVault && <p className="agent-destination">Redirect output to <code>{step.outputVault}</code></p>}</div>;
            case "balances": return <div key={index}><h3>After</h3><p className="muted">{decimal(step.inputUsdc)} testUSDC · {step.outputSol} testSOL · {step.remainingUsdc} testUSDC budget left</p></div>;
            case "notice": return step.code === "error" ? <div key={index}><Notice tone="error" message={step.message} /><p>Use Scripted to retry without AI.</p></div> : null;
            default: return null;
          }
        })}
      </div>
    </details>}
  </section>;
}
