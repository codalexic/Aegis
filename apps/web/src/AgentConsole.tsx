import { useEffect, useRef, useState, type JSX } from "react";
import type { VaultState } from "@aegis/sdk";
import { rawAmountToUi } from "../../../packages/sdk/src/amounts";
import type { Step } from "../../../scripts/agent/run";
import { Icon, type IconName } from "./icons";
import { describeError, PROGRAM_ERROR_MESSAGES } from "./errors";
import { Notice } from "./Notice";
import { ProgressButton } from "./Progress";

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
const SCENARIOS: { id: Scenario; icon: IconName; tone: string; title: string; text: string; outcome: string; button: string }[] = [
  { id: "normal", icon: "swap", tone: "", title: "Within the rules", text: "Swaps 20 testUSDC.", outcome: "Allowed: within the rules.", button: "Run normal trade" },
  { id: "injected", icon: "news", tone: "attack", title: "Fake news attack", text: "Hidden news tells the agent to spend 1,000.", outcome: "Blocked: over the per-trade cap.", button: "Inject malicious news" },
  { id: "attacker", icon: "redirect", tone: "hack", title: "Hacker redirect", text: "Tries to send the output to an attacker.", outcome: "Blocked: output must stay in the vault.", button: "Hacker redirect" },
];

function News({ step }: { step: Extract<Step, { type: "news" }> }) {
  const at = step.injection ? step.text.indexOf(step.injection) : -1;
  return <p className="agent-news">{at < 0 ? step.text : <>{step.text.slice(0, at)}<mark>{step.injection}</mark>{step.text.slice(at + step.injection!.length)}</>}</p>;
}

/** Light JSON highlighting: keys, strings, numbers and literals get their own colour. */
export function highlightJson(json: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g;
  let last = 0, match: RegExpExecArray | null;
  while ((match = token.exec(json))) {
    if (match.index > last) out.push(json.slice(last, match.index));
    const [whole, str, colon, num, lit] = match;
    const kind = str ? (colon ? "key" : "string") : num ? "number" : lit ? "literal" : "";
    out.push(<span key={match.index} className={`tok-${kind}`}>{str ?? whole}</span>);
    if (colon) out.push(colon);
    last = match.index + whole.length;
  }
  if (last < json.length) out.push(json.slice(last));
  return out;
}

function CodeBlock({ reply }: { reply: unknown }) {
  const isText = typeof reply === "string";
  const text = isText ? reply as string : JSON.stringify(reply, null, 2);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1500); return () => window.clearTimeout(timer); }, [copied]);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {}); };
  return <div className="code-block">
    <div className="code-block-head">
      <span>{isText ? "text" : "json"}</span>
      <button type="button" className="code-copy" onClick={copy}><Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied!" : "Copy"}</button>
    </div>
    <pre><code>{isText ? text : highlightJson(text)}</code></pre>
  </div>;
}

export function AgentConsole({ vault, finished, disabled, onBusy, onComplete, environment = "localnet", walletMode = false }: {
  environment?: "localnet" | "devnet"; walletMode?: boolean;
  vault: VaultState | null; finished: boolean; disabled: boolean; onBusy(busy: boolean): void; onComplete(): Promise<void>;
}) {
  const [live, setLive] = useState(false);
  const userChose = useRef(false);
  const [model, setModel] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastScenario, setLastScenario] = useState<Scenario>("normal");
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
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
    if (running.current || disabled || !vault || finished) return;
    running.current = true;
    setLastScenario(scenario); setBusy(true); onBusy(true); setError(null); setSteps([]);
    // This endpoint returns a complete run, not a stream. Do not invent a
    // timed transition from model inference to transaction confirmation.
    setProgress(useLive && scenario !== "attacker" ? "Asking the AI and checking the trade…" : "Sending to Solana…");
    try {
      const response = await fetch(`/api/agent/${scenario}`, {
        method: "POST", headers: { "content-type": "application/json", "x-aegis-agent": environment },
        body: JSON.stringify({ live: useLive, ...(walletMode && { vault: vault.address.toBase58() }) }),
      });
      const value = await response.json().catch(() => ({ error: response.status === 429
        ? "Demo request limit reached. Wait a minute before retrying."
        : "The server is temporarily unavailable. Try again later." }));
      if (!response.ok) {
        setError(describeError(typeof value.error === "string" ? value.error : "Agent request failed. Try again.").text);
      } else if (Array.isArray(value.steps)) setSteps(value.steps);
      else setError("The server returned an unreadable result. Try again.");
    } catch { setError("Could not reach the agent. Is the dashboard server running?"); }
    finally {
      setProgress("Refreshing vault…");
      try { await onComplete(); } catch { /* Confirmed outcomes remain authoritative during read outages. */ }
      running.current = false; setBusy(false); onBusy(false);
    }
  }

  const result = steps.find((step) => step.type === "result")?.result;
  const reply = steps.find((step) => step.type === "model_reply");
  const request = steps.find((step) => step.type === "request");
  const resisted = steps.some((step) => step.type === "notice" && step.code === "injection_resisted");
  const usable = !!vault && !finished;
  const locked = disabled || busy || !usable;
  const detailSteps = steps.filter((step) => step.type !== "result");
  return <>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{busy ? progress : ""}</span>
    <section id="agent" className="go-live agent-console" aria-labelledby="agent-title" aria-busy={busy}>
    <div className="go-live-head">
      <div>
        <div className="go-live-title"><h2 id="agent-title">Try the agent</h2></div>
        <p className="go-live-lead">{!vault ? "Set up and fund your vault first."
          : finished ? "This vault is finished. Start a new demo vault to try again."
          : "Run a normal trade, then try both attacks. Aegis checks every request on-chain."}</p>
      </div>
    </div>
    {live && !model && <p className="muted agent-model">No AI key is set up on this server. Switch back to Scripted to run the scenarios.</p>}
    <ul className="scenario-list">
      {SCENARIOS.map((scenario) => <li key={scenario.id} className="scenario">
        <span className={`scenario-icon ${scenario.tone}`} aria-hidden="true"><Icon name={scenario.icon} size={20} /></span>
        <div><strong>{scenario.title}</strong><p>{scenario.text}</p><p className={`scenario-outcome ${scenario.tone ? "blocked" : "allowed"}`}>{scenario.outcome}</p></div>
        <ProgressButton className={scenario.id === "normal" && usable ? "primary" : undefined} disabled={locked}
          busy={busy && lastScenario === scenario.id} progress="Running…" onClick={() => void run(scenario.id)}>{scenario.button}</ProgressButton>
      </li>)}
    </ul>
    <div className="agent-result-area" aria-busy={busy}>
      {reply && <p><span className="status">{reply.source === "live" ? "AI decided" : reply.source === "scripted" ? "Recorded reply" : "Fixed hacker request · No AI"}</span>{reply.source === "live" && model && <> {model}</>}</p>}
      {steps.some((step) => step.type === "notice" && step.code === "live_fallback") && <p>Live AI was busy, so a recorded reply was used.</p>}
      {busy && <div className="agent-running">
        <div><strong>{progress}</strong><p>{progress === "Refreshing vault…" ? "Updating balances and activity."
          : "Waiting for the agent’s result. Solana transactions can take 5–15 seconds; live AI adds a few more seconds."}</p></div>
      </div>}
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
            : <>{result.origin === "program" && vault ? `${rejectionReason(result.error, vault, request?.amountUsdc)} The vault is untouched.` : "The request could not be confirmed. Try again in a moment."}</>}</p>
        </div>
      </div>}
      {resisted && <div className="agent-resisted" role="status"><strong>The AI did not fall for it</strong>
        <p>It did not follow the planted headline, so whatever it actually proposed was sent as-is. Use Retry scripted to see what happens when an agent does obey the fake news.</p>
        <button className="small" disabled={locked} onClick={() => { setLive(false); void run("injected", false); }}>Retry scripted</button>
      </div>}
    </div>
    {detailSteps.length > 0 && <details className="agent-details">
      <summary>View details</summary>
      <div className="agent-steps" role="region" aria-label="Agent details">
        {detailSteps.map((step, index) => {
          switch (step.type) {
            case "news": return <div key={index}><h3>News the agent read</h3><News step={step} /></div>;
            case "model_reply": return <div key={index}><h3>{step.source === "live" ? "Model reply" : step.source === "scripted" ? "Scripted reply" : "Fixed hacker request · No AI"}</h3><CodeBlock reply={step.reply} /></div>;
            case "request": return <div key={index}><h3>Request sent to the vault</h3><p>{decimal(step.amountUsdc)} testUSDC</p>{step.outputVault && <p className="agent-destination">Redirect output to <code>{step.outputVault}</code></p>}</div>;
            case "balances": return <div key={index}><h3>After</h3><p className="muted">{decimal(step.inputUsdc)} testUSDC · {step.outputSol} testSOL · {step.remainingUsdc} testUSDC budget left</p></div>;
            case "notice": return step.code === "error" ? <div key={index}><Notice tone="error" message={step.message} /><p>Use Scripted to retry without AI.</p></div> : null;
            default: return null;
          }
        })}
      </div>
    </details>}
  </section></>;
}
