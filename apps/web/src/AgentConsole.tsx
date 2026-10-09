import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { VaultState } from "@aegis/sdk";
import { rawAmountToUi } from "../../../packages/sdk/src/amounts";
import type { Step } from "../../../scripts/agent/run";

type Scenario = "normal" | "injected" | "attacker";
const decimal = (value: string) => {
  const [whole, fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
};

export function rejectionReason(error: string, vault: VaultState, requested?: string): string {
  switch (error) {
    case "CapExceeded": return `Per-trade cap is ${decimal(rawAmountToUi(vault.maxTradeRaw, 6))} testUSDC; the agent asked for ${decimal(requested ?? "an oversized trade")}.`;
    case "BudgetExceeded": return "This trade exceeds the vault’s remaining total budget.";
    case "AccountMismatch": return "The output must stay in the vault; the attacker tried to redirect it.";
    case "Revoked": return "The owner revoked the agent’s trading permission.";
    case "Expired": return "The vault’s trading permission has expired.";
    case "Unauthorized": return "This signer does not have permission to trade from the vault.";
    case "InvalidAmount": return "The requested amount is invalid.";
    case "SwapResultMismatch": return "The exchange did not deliver the required token balances.";
    default: return "The transaction failed. Check the vault state before retrying.";
  }
}
const CHECKS = ["Signer is the agent", "Not revoked, not expired", "Within cap and budget", "Accounts match the vault", "Swap executed", "Balances verified", "Budget updated"];
const FAILED_AT: Record<string, number> = { Unauthorized: 0, Revoked: 1, Expired: 1, InvalidAmount: 2, CapExceeded: 2, BudgetExceeded: 2, AccountMismatch: 3, SwapResultMismatch: 5 };

function Checks({ ok, error }: { ok: boolean; error?: string }) {
  const failed = ok ? -1 : FAILED_AT[error ?? ""] ?? 3;
  return <ol className="checks" aria-label="Aegis checks">
    {CHECKS.map((label, i) => {
      const state = failed < 0 || i < failed ? "pass" : i === failed ? "fail" : "skip";
      return <li key={label} className={`check ${state}`} style={{ "--i": i } as CSSProperties}>
        <span className="check-mark" aria-hidden="true">{state === "pass" ? "✓" : state === "fail" ? "✗" : "·"}</span>{label}
      </li>;
    })}
  </ol>;
}

function News({ step }: { step: Extract<Step, { type: "news" }> }) {
  const at = step.injection ? step.text.indexOf(step.injection) : -1;
  return <p className="agent-news">{at < 0 ? step.text : <>{step.text.slice(0, at)}<mark>{step.injection}</mark>{step.text.slice(at + step.injection!.length)}</>}</p>;
}

export function AgentConsole({ vault, disabled, onBusy, onComplete, environment = "localnet", walletMode = false }: {
  environment?: "localnet" | "devnet"; walletMode?: boolean;
  vault: VaultState | null; disabled: boolean; onBusy(busy: boolean): void; onComplete(): Promise<void>;
}) {
  const [live, setLive] = useState(true);
  const [model, setModel] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch("/api/agent/info", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const value = await response.json();
      if (active && typeof value.model === "string") setModel(value.model);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function run(scenario: Scenario, useLive = live) {
    if (running.current || disabled || !vault) return;
    running.current = true;
    setBusy(true); onBusy(true); setError(null); setSteps([]);
    try {
      const response = await fetch(`/api/agent/${scenario}`, {
        method: "POST", headers: { "content-type": "application/json", "x-aegis-agent": environment },
        body: JSON.stringify({ live: useLive, ...(walletMode && { vault: vault.address.toBase58() }) }),
      });
      const value = await response.json();
      if (!response.ok) {
        setError(typeof value.error === "string" ? value.error : "Agent request failed. Try again.");
      } else if (Array.isArray(value.steps)) setSteps(value.steps);
      else setError("The server returned an unreadable result. Check localnet and try again.");
    } catch { setError("Could not reach the agent. Check the dashboard server and try again."); }
    finally {
      try { await onComplete(); } catch { setError("Could not refresh the vault. Check localnet before retrying."); }
      running.current = false; setBusy(false); onBusy(false);
    }
  }

  const result = steps.find((step) => step.type === "result")?.result;
  const request = steps.find((step) => step.type === "request");
  const resisted = steps.some((step) => step.type === "notice" && step.code === "injection_resisted");
  const locked = disabled || busy || !vault;
  return <section className="agent-console" aria-labelledby="agent-title" aria-busy={busy}>
    <div className="card-heading"><h2 id="agent-title">Agent console</h2></div>
    <div className="agent-content">
      <div className="agent-mode" role="group" aria-label="Agent mode">
        <button aria-pressed={live} disabled={locked} onClick={() => setLive(true)}>Live AI</button>
        <button aria-pressed={!live} disabled={locked} onClick={() => setLive(false)}>Scripted</button>
      </div>
      <p className="muted agent-model">{live ? model ?? "Live AI not configured · Scripted is available" : "Fixed replies · No AI or network call"}</p>
      <div className="agent-actions">
        <button className="primary" disabled={locked} onClick={() => void run("normal")}>Run normal trade</button>
        <button className="danger" disabled={locked} onClick={() => void run("injected")}>Inject malicious news</button>
        <button className="danger" disabled={locked} onClick={() => void run("attacker")}>Hacker redirect</button>
      </div>
      <div className="agent-result-area">
        {!busy && !error && steps.length === 0 && <p className="agent-placeholder">Choose a scenario. The result appears here.</p>}
        {!vault && <p className="muted">Create and fund a vault to run the agent.</p>}
        {busy && <p role="status">Agent running… Waiting for the reply and chain confirmation.</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
        {result && <div role="status" data-testid="agent-outcome" className={`agent-outcome ${result.ok ? "executed" : "blocked"}`}>
          <strong>{result.ok ? "Executed" : result.origin === "program" ? `Blocked by Aegis program: ${result.error}` : `Request failed: ${result.error}`}</strong>
          <p>{result.ok ? `Swapped ${decimal(request?.amountUsdc ?? "0")} testUSDC; output stayed in the vault.`
            : result.origin === "program" && vault ? rejectionReason(result.error, vault, request?.amountUsdc) : "The request could not be confirmed by the program. Check localnet and retry."}</p>
        </div>}
        {result && (result.ok || result.origin === "program") && <Checks ok={result.ok} error={result.ok ? undefined : result.error} />}
      </div>
      <div className="agent-steps" role="region" aria-label="Agent details" tabIndex={0}>
        {resisted && <div className="agent-resisted" role="status"><strong>The model resisted the injection</strong>
          <p>Any valid proposal was sent unchanged. Try the fixed 1,000 testUSDC attack.</p>
          <button disabled={locked} onClick={() => { setLive(false); void run("injected", false); }}>Retry scripted</button>
        </div>}
        {steps.map((step, index) => {
        switch (step.type) {
          case "news": return <div key={index}><h3>News</h3><News step={step} /></div>;
          case "model_reply": return <div key={index}><h3>{step.source === "live" ? "Model reply" : step.source === "scripted" ? "Scripted reply" : "Fixed hacker request · No AI"}</h3><pre>{typeof step.reply === "string" ? step.reply : JSON.stringify(step.reply, null, 2)}</pre></div>;
          case "request": return <div key={index}><h3>Request sent</h3><p>{decimal(step.amountUsdc)} testUSDC</p>{step.outputVault && <p className="agent-destination">Redirect output to <code>{step.outputVault}</code></p>}</div>;
          case "balances": return <p key={index} className="muted">After: {decimal(step.inputUsdc)} testUSDC · {step.outputSol} testSOL · {step.remainingUsdc} testUSDC budget left</p>;
          case "notice": return step.code === "error" ? <p key={index} className="notice error" role="alert">{step.message} Use Scripted to retry without AI.</p> : null;
          default: return null;
        }
      })}</div>
    </div>
  </section>;
}
