import { useEffect, useRef, useState, type JSX } from "react";
import type { TxResult, VaultState } from "@aegis/sdk";
import { rawAmountToUi } from "../../../packages/sdk/src/amounts";
import type { Step } from "../../../scripts/agent/run";
import { Icon, type IconName } from "./icons";
import { describeError, PROGRAM_ERROR_MESSAGES } from "./errors";
import { ProgressButton } from "./Progress";
import { useCopy } from "./use-copy";
import type { Scenario } from "./client";

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

// Plain-language framing for each scenario. Keep the button labels stable: server error copy refers to them.
const SCENARIOS: { id: Scenario; icon: IconName; tone: string; title: string; story: string; text: string; outcome: string; button: string }[] = [
  { id: "normal", icon: "swap", tone: "", title: "Within the rules", story: "Your AI makes an ordinary trade. Aegis checks it and lets it through.",
    text: "Swaps 20 testUSDC.", outcome: "Allowed: within the rules.", button: "Run normal trade" },
  { id: "injected", icon: "news", tone: "attack", title: "Fake news attack", story: "Someone plants a fake headline telling your AI to go all-in. Even if the AI is fooled, Aegis caps the trade.",
    text: "Hidden news tells the agent to spend 1,000.", outcome: "Blocked: over the per-trade cap.", button: "Inject malicious news" },
  { id: "attacker", icon: "redirect", tone: "hack", title: "Hacker redirect", story: "A hacked tool tries to send your coins to a stranger’s wallet. Aegis only pays out into your vault.",
    text: "Tries to send the output to an attacker.", outcome: "Blocked: output must stay in the vault.", button: "Hacker redirect" },
];

function News({ step }: { step: Extract<Step, { type: "news" }> }) {
  const at = step.injection ? step.text.indexOf(step.injection) : -1;
  return <p className="agent-news">{at < 0 ? step.text : <>{step.text.slice(0, at)}<mark>{step.injection}</mark>{step.text.slice(at + step.injection!.length)}</>}</p>;
}

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
  const [copied, copy] = useCopy(text);
  return <div className="code-block">
    <div className="code-block-head">
      <span>{isText ? "text" : "json"}</span>
      <button type="button" className="code-copy" onClick={copy}><Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied!" : "Copy"}</button>
    </div>
    <pre><code>{isText ? text : highlightJson(text)}</code></pre>
  </div>;
}

type Check = "" | "pass" | "fail" | "wait";
const CHECKS = ["Trade size", "Budget", "Destination"];
const REQUESTER: Record<Scenario, string> = { normal: "AI agent", injected: "AI agent", attacker: "Hacked tool" };

/** Which of the three rules the request cleared, in the order the program checks them. */
function checksFor(result: TxResult | undefined, busy: boolean): [Check, Check, Check] {
  if (busy) return ["wait", "wait", "wait"];
  if (!result) return ["", "", ""];
  if (result.ok) return ["pass", "pass", "pass"];
  if (result.origin !== "program") return ["", "", ""];
  switch (result.error) {
    case "CapExceeded": return ["fail", "", ""];
    case "BudgetExceeded": return ["pass", "fail", ""];
    case "AccountMismatch": return ["pass", "pass", "fail"];
    default: return ["", "", ""];
  }
}

/** Server-side agent failures in plain words; the raw message stays under technical details. */
export function friendlyAgentError(message: string): string {
  if (/\.keys\/|devnet:deploy|agent key/i.test(message)) return "The demo AI agent isn’t set up on this server yet, so it can’t send trades.";
  if (/rate|429|limit reached/i.test(message)) return "Too many demo requests right now. Wait a minute, then try again.";
  if (/reach|network|fetch|unavailable/i.test(message)) return "The demo server couldn’t be reached. Check your connection and try again.";
  return message;
}

function Flow({ id, steps, busy, failed }: { id: Scenario; steps: Step[]; busy: boolean; failed: boolean }) {
  const result = steps.find((step) => step.type === "result")?.result;
  const amountUsdc = steps.find((step) => step.type === "request")?.amountUsdc;
  const checks = checksFor(result, busy);
  // The demo exchange pays 1 testSOL per 100 testUSDC.
  const sol = amountUsdc && result?.ok ? String(Number(amountUsdc) / 100) : null;
  const note = busy ? null : result ? (result.ok ? `+${sol} testSOL received` : result.origin === "program" ? "Nothing moved" : "Not confirmed")
    : failed ? "The request never reached Aegis" : null;
  const idle = failed ? "Not sent" : busy ? "Sending the request…" : "Waiting for a request";
  return <div className="flow" data-state={busy ? "run" : result ? (result.ok ? "ok" : "no") : failed ? "error" : "idle"} aria-hidden="true">
    <div className="flow-node">
      <span className="flow-k"><Icon name={id === "attacker" ? "redirect" : "robot"} size={14} />{REQUESTER[id]} asks for</span>
      {amountUsdc && !busy ? <span className="flow-v">{decimal(amountUsdc)}<small>testUSDC</small></span>
        : <span className="flow-idle">{idle}</span>}
    </div>
    <span className="flow-wire"><i /></span>
    <div className="flow-node flow-gate">
      <span className="flow-k"><Icon name="shield" size={14} />Aegis checks</span>
      <span className="v-checks">{checks.map((check, index) => <span key={CHECKS[index]} className={`v-check ${check}`} style={{ ["--n" as string]: index }}>
        {check === "pass" ? <Icon name="check" size={11} /> : check === "fail" ? <Icon name="x" size={11} /> : <i />}{CHECKS[index]}
      </span>)}</span>
    </div>
    <span className="flow-wire flow-wire--out"><i /></span>
    <div className="flow-node flow-result">
      <span className="flow-k"><Icon name="vault" size={14} />Your vault</span>
      {result && !busy ? <span className="flow-v">{result.ok ? "Allowed" : result.origin === "program" ? "Blocked" : "Failed"}</span>
        : <span className="flow-idle">{busy ? "Waiting for Solana…" : "Untouched"}</span>}
      {note && <span className="flow-note">{note}</span>}
    </div>
  </div>;
}

export function AgentConsole({ vault, finished, disabled, onBusy, onComplete, environment = "localnet", walletMode = false, runScenario }: {
  environment?: "localnet" | "devnet" | "mock"; walletMode?: boolean;
  vault: VaultState | null; finished: boolean; disabled: boolean; onBusy(busy: boolean): void; onComplete(): Promise<void>;
  /** Runs a case in-process instead of through the agent API (mock mode). */
  runScenario?(kind: Scenario): Promise<Step[]>;
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
  // Each case keeps its last run, so the list can show all three outcomes.
  const [lanes, setLanes] = useState<Partial<Record<Scenario, Step[]>>>({});
  const [selected, setSelected] = useState<Scenario>("normal");
  useEffect(() => {
    if (runScenario) return;
    let active = true;
    void fetch("/api/agent/info", { cache: "no-store" }).then(async (response) => {
      const value = response.ok ? await response.json().catch(() => ({})) : {};
      if (!active) return;
      const configured = typeof value.model === "string";
      setModel(configured ? value.model : null);
      if (configured && !userChose.current) setLive(true);
    }).catch(() => {});
    return () => { active = false; };
  }, [runScenario]);

  async function run(scenario: Scenario, useLive = live) {
    if (running.current || disabled || !vault || finished) return;
    running.current = true;
    setLastScenario(scenario); setSelected(scenario); setBusy(true); onBusy(true); setError(null); setSteps([]);
    // This endpoint returns a complete run, not a stream. Do not invent a
    // timed transition from model inference to transaction confirmation.
    setProgress(useLive && !runScenario && scenario !== "attacker" ? "Asking the AI and checking the trade…" : "Sending to Solana…");
    try {
      if (runScenario) {
        const local = await runScenario(scenario);
        setSteps(local); setLanes((lanes) => ({ ...lanes, [scenario]: local }));
        return;
      }
      const response = await fetch(`/api/agent/${scenario}`, {
        method: "POST", headers: { "content-type": "application/json", "x-aegis-agent": environment },
        body: JSON.stringify({ live: useLive, ...(walletMode && { vault: vault.address.toBase58() }) }),
      });
      const value = await response.json().catch(() => ({ error: response.status === 429
        ? "Demo request limit reached. Wait a minute before retrying."
        : "The server is temporarily unavailable. Try again later." }));
      if (!response.ok) {
        setError(describeError(typeof value.error === "string" ? value.error : "Agent request failed. Try again.").text);
      } else if (Array.isArray(value.steps)) { setSteps(value.steps); setLanes((lanes) => ({ ...lanes, [scenario]: value.steps })); }
      else setError("The server returned an unreadable result. Try again.");
    } catch { setError("Could not reach the agent. Is the dashboard server running?"); }
    finally {
      setProgress("Refreshing vault…");
      try { await onComplete(); } catch { /* Confirmed outcomes remain authoritative during read outages. */ }
      running.current = false; setBusy(false); onBusy(false);
    }
  }

  const usable = !!vault && !finished;
  const locked = disabled || busy || !usable;
  const current = SCENARIOS.find((scenario) => scenario.id === selected)!;
  const selectedBusy = busy && lastScenario === selected;
  const stepsFor = (id: Scenario) => busy && lastScenario === id ? [] : id === lastScenario ? steps : lanes[id] ?? [];
  // A run fails without a result when the request can't be made, or the agent reports an error step.
  const failureFor = (id: Scenario) => {
    const notice = stepsFor(id).find((step) => step.type === "notice" && step.code === "error");
    return (id === lastScenario && !busy && error) || (notice?.type === "notice" ? notice.message : null);
  };
  const shown = stepsFor(selected);
  const result = shown.find((step) => step.type === "result")?.result;
  const failure = result ? null : failureFor(selected);
  const reply = shown.find((step) => step.type === "model_reply");
  const request = shown.find((step) => step.type === "request");
  const resisted = shown.some((step) => step.type === "notice" && step.code === "injection_resisted");
  const detailSteps = shown.filter((step) => step.type !== "result");
  const retry = () => { if (live) setLive(false); void run(selected, false); };
  return <>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{busy ? progress : ""}</span>
    <section id="agent" className="agent-console" aria-label="Test cases" aria-busy={busy}>
    <div className="cases-bar">
      {!finished && <p className="card-sub">{!vault ? "Set up and fund your vault first." : "Run a normal trade, then try both attacks."}</p>}
      {model && <span className="badge">Live AI · {model}</span>}
    </div>
    {live && !model && <p className="muted agent-model">No AI key is set up on this server. Switch back to Scripted to run the scenarios.</p>}
    <ul className="scenario-list">
      {SCENARIOS.map((scenario) => {
        const running = busy && lastScenario === scenario.id;
        const last = stepsFor(scenario.id).find((step) => step.type === "result")?.result;
        const failed = !last && !running && failureFor(scenario.id);
        return <li key={scenario.id} className={`scenario ${scenario.tone}${scenario.id === selected ? " is-selected" : ""}`} onClick={() => setSelected(scenario.id)}>
          <div className="scenario-top">
            <span className={`scenario-icon ${scenario.tone}`} aria-hidden="true"><Icon name={scenario.icon} size={18} /></span>
            <span className="scenario-last">{running ? <span className="badge"><span className="progress-spinner" aria-hidden="true" />Running</span>
              : last ? <span className={`badge ${last.ok ? "ok" : "bad"}`}>{last.ok ? "Allowed" : last.origin === "program" ? "Blocked" : "Failed"}</span>
              : failed ? <span className="badge warn">Didn’t run</span> : null}</span>
          </div>
          <div className="scenario-copy"><strong>{scenario.title}</strong><p>{scenario.text}</p><p className={`scenario-outcome ${scenario.tone ? "blocked" : "allowed"}`}>{scenario.outcome}</p></div>
          <ProgressButton className={scenario.id === "normal" && usable ? "primary" : undefined} disabled={locked}
            busy={running} progress="Running…" onClick={(event) => { event.stopPropagation(); void run(scenario.id); }}>{scenario.button}</ProgressButton>
        </li>;
      })}
    </ul>

    <section className="card" aria-labelledby="result-title">
      <div className="card-head"><div><h2 id="result-title">{current.title}</h2><p className="card-sub">{current.story}</p></div></div>
      <Flow id={selected} steps={shown} busy={selectedBusy} failed={!!failure} />
      <div className="agent-result-area" aria-busy={selectedBusy}>
        {reply && <p className="agent-source"><span className="status">{reply.source === "live" ? "AI decided" : reply.source === "scripted" ? "Recorded reply" : "Fixed hacker request · No AI"}</span>{reply.source === "live" && model && <> {model}</>}</p>}
        {shown.some((step) => step.type === "notice" && step.code === "live_fallback") && <p className="agent-source">Live AI was busy, so a recorded reply was used.</p>}
        {selectedBusy && <div className="agent-running">
          <span className="progress-spinner" aria-hidden="true" />
          <div><strong>{progress}</strong><p>{progress === "Refreshing vault…" ? "Updating balances and activity."
            : "Waiting for the agent’s result. Solana transactions can take 5–15 seconds; live AI adds a few more seconds."}</p></div>
        </div>}
        {failure && <div className="agent-outcome failed" role="alert">
          <span className="outcome-icon" aria-hidden="true"><Icon name="alert" /></span>
          <div><strong>The agent couldn’t run</strong><p>{friendlyAgentError(failure)}</p></div>
          <div className="buttons"><button className="small" disabled={locked} onClick={retry}>{live ? "Retry scripted" : "Try again"}</button></div>
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
        {!result && !failure && !selectedBusy && <p className="result-hint">Press <b>{current.button}</b> to send this request through Aegis.</p>}
      </div>
      {detailSteps.length > 0 && <details className="agent-details">
        <summary>Show technical details</summary>
        <div className="agent-steps" role="region" aria-label="Agent details">
          {detailSteps.map((step, index) => {
            switch (step.type) {
              case "news": return <div key={index}><h3>News the agent read</h3><News step={step} /></div>;
              case "model_reply": return <div key={index}><h3>{step.source === "live" ? "Model reply" : step.source === "scripted" ? "Scripted reply" : "Fixed hacker request · No AI"}</h3><CodeBlock reply={step.reply} /></div>;
              case "request": return <div key={index}><h3>Request sent to the vault</h3><p>{decimal(step.amountUsdc)} testUSDC</p>{step.outputVault && <p className="agent-destination">Redirect output to <code>{step.outputVault}</code></p>}</div>;
              case "balances": return <div key={index}><h3>After</h3><p className="muted">{decimal(step.inputUsdc)} testUSDC · {step.outputSol} testSOL · {step.remainingUsdc} testUSDC budget left</p></div>;
              case "notice": return step.code === "error" ? <div key={index}><h3>Server message</h3><p className="agent-error-raw"><code>{step.message}</code></p></div> : null;
              default: return null;
            }
          })}
        </div>
      </details>}
    </section>
  </section></>;
}
