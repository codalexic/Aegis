import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import type { AegisEnvironment, Activity, TxResult, VaultState } from "@aegis/sdk";
import { rawAmountToUi, uiAmountToRaw } from "../../../packages/sdk/src/amounts";
import { connectDashboard, type DashboardConnection } from "./client";
import type { ActionDetail } from "./activity";
import { AgentConsole, blockedTitle, rejectionReason } from "./AgentConsole";
import { useWallet } from "./wallet-react";
import { connectWalletDashboard } from "./wallet-client";
import { startDashboardPolling } from "./polling";
import { isRateLimited, RPC_RATE_LIMITED } from "../../../packages/sdk/src/errors";
import { explorerTransactionUrl } from "../../../packages/sdk/src/explorer";
import { Icon, type IconName } from "./icons";
import { Logo } from "./Logo";
import { SidebarIllustration } from "./Illustration";
import { TradeBars, type TradeBar } from "./TradeBars";
import { Notice } from "./Notice";

const nowUnix = () => BigInt(Math.floor(Date.now() / 1000));
const shorten = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
const VAULT_LIFETIME = 3600n; // seconds; the program sets expiry = creation + 1h

function amount(raw: bigint, decimals = 6): string {
  const [whole, fraction] = rawAmountToUi(raw, decimals).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

/** Groups a leading 4+ digit integer ("1000 testUSDC" → "1,000 testUSDC"); "—", "20 testUSDC", "0.2 testSOL" and grouped strings are untouched. */
const groupThousands = (text: string) => text.replace(/^\d{4,}(?=(?:\.\d+)? )/, (n) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ","));

function countdown(expiry: bigint, now: bigint): string {
  const remaining = expiry > now ? expiry - now : 0n;
  return remaining === 0n ? "Expired" : `${remaining / 60n}m ${(remaining % 60n).toString().padStart(2, "0")}s`;
}

function timeLabel(unix?: bigint): string {
  return unix === undefined ? "—" : new Date(Number(unix * 1000n)).toLocaleTimeString([], { hour12: false });
}

const environmentName = (e: AegisEnvironment) => e === "mock" ? "Practice mode" : e === "localnet" ? "Private test chain" : "Solana devnet";
const environmentShort = (e: AegisEnvironment) => e === "mock" ? "Practice" : e === "localnet" ? "Localnet" : "Devnet";
const environmentTitle = (environment: AegisEnvironment) => environment === "devnet"
  ? "Solana devnet: a public test network. Tokens have no value. Set Phantom to devnet."
  : environment === "localnet" ? "A private Solana test chain running on this machine. Tokens have no value."
  : "Simulated: nothing is sent anywhere. Refreshing the page starts over.";

/* --------------------------------------------------------------------------
   Shell: sidebar · content · rail. Pure layout; all state lives in Dashboard.
   -------------------------------------------------------------------------- */
const NAV: { id: string; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "vault", label: "Vault", icon: "vault" },
  { id: "agent", label: "Agent", icon: "robot" },
  { id: "activity", label: "Activity", icon: "activity" },
];

function Shell({ active, cta, rail, hideNav, children }: {
  active: string; cta?: ReactNode; rail?: ReactNode; hideNav?: boolean; children: ReactNode;
}) {
  if (hideNav) {
    return <div className="shell shell--start"><main className="content">{children}</main></div>;
  }
  return <div className={`shell shell--dark${rail ? "" : " shell--no-rail"}`}>
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Aegis home"><Logo size={30} withWordmark /></a>
      <nav className="nav" aria-label="Sections">
        {NAV.map((item) => <a key={item.id} href={`#${item.id}`} aria-current={active === item.id ? "true" : undefined}><Icon name={item.icon} size={18} />{item.label}</a>)}
      </nav>
      <div className="sidebar-foot">
        <SidebarIllustration className="sidebar-illustration" />
        {cta}
      </div>
    </aside>
    <main className="content">{children}</main>
    {rail ? <aside className="rail">{rail}</aside> : null}
  </div>;
}

/** Highlights the sidebar link for whichever section is nearest the top of the viewport. */
function useActiveSection(ready: boolean): string {
  const [active, setActive] = useState(NAV[0].id);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const elements = NAV.map((item) => document.getElementById(item.id)).filter((element): element is HTMLElement => element !== null);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-15% 0px -65% 0px" });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [ready]);
  return active;
}

/** True while the viewport matches `query`; tracks changes so the rail can move inline below 1240px. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export function App() {
  const environment = import.meta.env.AEGIS_ENV as AegisEnvironment;
  const wallet = useWallet();
  const walletMode = import.meta.env.AEGIS_WALLET === true;
  const walletAddress = wallet.publicKey?.toBase58();
  const activeWallet = useRef(walletAddress);
  activeWallet.current = walletAddress;
  const [connection, setConnection] = useState<DashboardConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setConnection(null); setError(null);
    if (walletMode && (!wallet.publicKey || !wallet.signTransaction)) return;
    const pending = walletMode ? connectWalletDashboard(environment as "localnet" | "devnet", {
      publicKey: wallet.publicKey!, signTransaction: async (transaction) => {
        if (activeWallet.current !== walletAddress) throw new Error("Wallet changed.");
        const signed = await wallet.signTransaction!(transaction);
        if (activeWallet.current !== walletAddress) throw new Error("Wallet changed.");
        return signed;
      },
    }) : connectDashboard(environment);
    void pending.then((value) => { if (active) setConnection(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Connection failed."); });
    return () => { active = false; };
  }, [environment, walletMode, walletAddress, wallet.signTransaction]);

  const walletControl = (className: string) => walletMode && <button type="button" className={className} disabled={wallet.connecting || wallet.disconnecting} onClick={() => void (wallet.connected ? wallet.disconnect() : wallet.connect()).catch(() => {})}>
    <Icon name="wallet" size={16} />{wallet.connected ? "Disconnect" : "Connect wallet"}
  </button>;
  const environmentPill = <div className="environment" title={environmentTitle(environment)}><span className="environment-dot" />{environmentShort(environment)}</div>;
  const startBar = <header className="start-bar">
    <a className="brand start-brand" href="/" aria-label="Aegis home"><Logo size={36} withWordmark /></a>
    <div className="rail-top">{environmentPill}{walletControl("start-connect")}</div>
  </header>;

  if (!connection) {
    const waitingForWallet = walletMode && !wallet.connected;
    return <Shell active="overview" hideNav>
      <div className={waitingForWallet ? "start" : "start connecting-screen"}>
        {startBar}
        {waitingForWallet ? <>
          <div className="start-hero">
            <h1>AI agents can be tricked. Aegis still enforces the limits.</h1>
            {error
              ? <Notice tone="error" message={error} />
              : <p className="connecting-hint" role="status">You only need a wallet and a bit of SOL on Solana Devnet to use your agent safely with us.</p>}
          </div>
          {environment === "devnet" && <TryIt />}
        </> : error
          ? <div className="connecting"><Notice tone="error" message={error} /></div>
          : <div className="connecting" role="status" aria-live="polite" aria-busy="true">
            <div className="connecting-mark" aria-hidden="true"><span className="connecting-ring" /><Logo size={40} /></div>
            <p>Connecting to the vault…</p>
          </div>}
      </div>
    </Shell>;
  }
  return <Dashboard key={`${environment}:${connection.owner.toBase58()}`} connection={connection} toolbar={<>{environmentPill}{walletControl("small rail-action")}</>} />;
}

const TRY_STEPS: { title: string; body: ReactNode }[] = [
  {
    title: "Install Phantom",
    body: <>Download from <a href="https://phantom.com/download" target="_blank" rel="noreferrer">phantom.com</a></>,
  },
  {
    title: "Point Phantom at Devnet",
    body: "In Phantom: Settings → Developer Settings → turn on Testnet Mode → choose Solana Devnet. Your mainnet funds stay untouched.",
  },
  {
    title: "Connect here",
    body: "Hit Connect wallet in the top right, then approve the request in Phantom. That wallet is your identity for this demo.",
  },
  {
    title: "Fund a vault and try to break it",
    body: "Open a New demo vault to get 1,000 testUSDC under the agent's limits - then run the attack scenarios and see what Aegis blocks.",
  },
];

function TryIt() {
  return <aside className="try-it" aria-labelledby="try-it-title">
    <header className="try-it-head">
      <h2 id="try-it-title">How to try it?</h2>
      <p className="try-it-lead">A quick walkthrough on Solana Devnet for you to get started.</p>
    </header>
    <ol className="try-it-steps">
      {TRY_STEPS.map((step, index) => <li key={step.title} data-step={index + 1}>
        <span className="try-it-marker" aria-hidden="true">{index + 1}</span>
        <div>
          <strong className="try-it-title">{step.title}</strong>
          <p className="try-it-detail">{step.body}</p>
        </div>
      </li>)}
    </ol>
    <p className="try-it-foot">Out of fee SOL? Use the <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">Solana Faucet</a>.</p>
  </aside>;
}

/* --------------------------------------------------------------------------
   Small presentational pieces
   -------------------------------------------------------------------------- */
function Tile({ tone, icon, label, value, unit, sub, subTone, testId, children }: {
  tone: "lavender" | "mist" | "mint" | "cream"; icon: IconName; label: string; value: string; unit?: string;
  sub?: ReactNode; subTone?: "good" | "bad" | "warning"; testId?: string; children?: ReactNode;
}) {
  return <div className={`tile tile--${tone}`}>
    <span className="tile-icon"><Icon name={icon} /></span>
    <span className="tile-label">{label}</span>
    <div className="tile-value"><strong data-testid={testId} className={value === "—" ? "placeholder" : undefined}>{value}</strong>{unit && <small>{unit}</small>}</div>
    {sub && <span className={`tile-sub ${subTone ?? ""}`}>{sub}</span>}
    {children}
  </div>;
}

function Step({ number, state, title, text, children }: { number: number; state: "done" | "next" | "todo"; title: string; text: string; children: ReactNode }) {
  return <div className={`step ${state}`}>
    <span className="step-num" aria-hidden="true">{state === "done" ? <Icon name="check" size={18} /> : number}</span>
    <div><strong>{state === "done" && <span className="sr-only">Done: </span>}{title}</strong><p>{text}</p></div>
    {children}
  </div>;
}

function KeyRow({ label, value, note }: { label: string; value: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1500); return () => window.clearTimeout(timer); }, [copied]);
  const copy = () => { void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => {}); };
  return <div className="key-row">
    <span className="label">{label}{note && <small> · {note}</small>}</span>
    <code title={value} aria-label={value}>{shorten(value)}</code>
    <button className="icon-button" type="button" onClick={copy} aria-label={copied ? `${label} address copied` : `Copy ${label} address`} title={copied ? "Copied" : "Copy"}><Icon name={copied ? "check" : "copy"} size={16} /></button>
  </div>;
}

/* --------------------------------------------------------------------------
   Dashboard
   -------------------------------------------------------------------------- */
function Dashboard({ connection, toolbar }: { connection: DashboardConnection; toolbar: ReactNode }) {
  const { client, owner, agent, environment } = connection;
  const address = useRef<PublicKey | null>(connection.initialVault);
  const details = useRef(new Map<string, ActionDetail>());
  const running = useRef(false);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [now, setNow] = useState(nowUnix);
  const [busy, setBusy] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: true; text: string } | { ok: false; text: unknown } | null>(null);
  const [tradeAmount, setTradeAmount] = useState("20");
  const [ready, setReady] = useState(environment === "mock" || !connection.initialVault);
  const refreshing = useRef(false);
  const currentState = useRef<VaultState | null>(null);
  const polling = useRef<ReturnType<typeof startDashboardPolling> | null>(null);
  const active = useActiveSection(ready);
  const narrow = useMediaQuery("(max-width: 1240px)");

  const refreshState = useCallback(async () => {
    setNow(nowUnix());
    if (!address.current) return;
    const selected = address.current;
    try {
      const state = await client.getVault(selected);
      if (address.current !== selected) return;
      currentState.current = state;
      setVault(state);
      setReady(true);
    } catch (error) {
      if (address.current !== selected) return;
      if (error instanceof Error && error.message === "VaultNotFound") {
        currentState.current = null;
        setVault(null); setActivity([]); setReady(true); return;
      }
      throw error;
    }
  }, [client]);

  const refreshActivity = useCallback(async () => {
    const selected = address.current, state = currentState.current;
    if (!selected || !state || !state.address.equals(selected)) return;
    const history = await client.listActivity(selected);
    const read = async (item: Activity) => {
      const detail = await connection.readDetail!(item.signature, state);
      if (detail && address.current === selected) details.current.set(item.signature, detail);
    };
    if (connection.readDetail) {
      const missing = history.filter((item) => !details.current.has(item.signature));
      if (environment === "devnet") {
        for (const item of missing) await read(item);
      } else await Promise.all(missing.map(read));
    }
    if (address.current === selected) setActivity(history);
  }, [client, connection, environment]);

  const refresh = useCallback(async () => {
    if (environment === "devnet") { await polling.current?.refresh(); return; }
    if (refreshing.current) return;
    refreshing.current = true;
    try { await refreshState(); await refreshActivity(); }
    finally { refreshing.current = false; }
  }, [environment, refreshState, refreshActivity]);

  useEffect(() => {
    const onError = (error: unknown) => setNotice((current) => current?.ok === false ? current : {
      ok: false, text: isRateLimited(error) ? RPC_RATE_LIMITED : environment === "localnet"
        ? "Lost contact with the test chain. Is the local validator still running?"
        : "Could not refresh the vault. Retrying…",
    });
    if (environment === "devnet") {
      const scheduler = startDashboardPolling({ state: refreshState, activity: refreshActivity, onError });
      polling.current = scheduler;
      // Countdown is local UI work, independent of RPC polling.
      const clock = window.setInterval(() => setNow(nowUnix()), 1000);
      return () => { scheduler.stop(); polling.current = null; window.clearInterval(clock); };
    }
    void refresh().catch(onError);
    const timer = window.setInterval(() => { void refresh().catch(onError); }, 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshState, refreshActivity, environment]);

  useEffect(() => {
    if (!notice?.ok) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function track<T extends TxResult>(result: T, detail: ActionDetail): T {
    if (result.signature) details.current.set(result.signature, detail);
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  async function run(label: string, action: () => Promise<string>) {
    if (running.current || agentBusy) return;
    running.current = true;
    setBusy(label);
    setNotice(null);
    try {
      setNotice({ ok: true, text: await action() });
    } catch (error) {
      setNotice({ ok: false, text: error });
    } finally {
      try { await refresh(); } catch { setNotice((current) => current?.ok === false ? current : { ok: false, text: "Could not refresh the vault. Retrying…" }); }
      running.current = false;
      setBusy(null);
    }
  }

  const create = () => run("Create vault", async () => {
    const result = track(await connection.create(), { label: "Create vault", amount: "—" });
    if (!result.vault) throw new Error("No vault address was returned.");
    address.current = result.vault;
    return "Vault created. Next: add 1,000 testUSDC.";
  });

  const fund = () => run("Fund vault", async () => {
    track(await connection.fund(address.current!), { label: "Fund vault", amount: "1,000 testUSDC" });
    return `Added 1,000 testUSDC. Next: ${environment === "mock" ? "try a trade" : "try the agent"} below.`;
  });

  const newDemo = () => run("New demo vault", async () => {
    const result = await connection.newDemo();
    if (result.vault) {
      address.current = result.vault;
      details.current.clear();
      setVault(null);
      setActivity([]);
      setReady(false);
    }
    if (result.createSignature) track({ ok: true, signature: result.createSignature }, { label: "Create vault", amount: "—" });
    track(result, { label: "Fund vault", amount: "1,000 testUSDC" });
    if (!result.vault) throw new Error("No vault address was returned.");
    return `Your demo vault is ready with 1,000 testUSDC. Next: ${environment === "mock" ? "try a trade" : "try the agent"} below.`;
  });

  const revoke = () => run("Revoke agent", async () => {
    track(await connection.revoke(address.current!), { label: "Revoke agent", amount: "—" });
    return "Agent revoked. You can still withdraw your funds.";
  });

  const withdraw = () => run("Withdraw all", async () => {
    const state = await client.getVault(address.current!);
    for (const [mint, balance, decimals, symbol] of [
      [state.inputMint, state.inputBalanceRaw, 6, "testUSDC"],
      [state.outputMint, state.outputBalanceRaw, 9, "testSOL"],
    ] as const) {
      if (balance > 0n) track(await connection.withdraw(state.address, mint, balance), {
        label: "Withdraw", amount: `${amount(balance, decimals)} ${symbol}`,
      });
    }
    return "Everything is back in your wallet.";
  });

  function trade(event: FormEvent) {
    event.preventDefault();
    void run("Agent trade", async () => {
      let raw: bigint;
      try { raw = uiAmountToRaw(tradeAmount, 6); }
      catch { throw new Error("Enter a valid testUSDC amount with up to 6 decimal places."); }
      if (!connection.trade) throw new Error("Run the localnet agent from the terminal.");
      track(await connection.trade(address.current!, raw), { label: "Agent swap", amount: `${amount(raw)} testUSDC` });
      return `Swapped ${amount(raw)} testUSDC for ${amount(raw * 10n, 9)} testSOL.`;
    });
  }

  /* ---- derived state ---- */
  const remaining = vault ? vault.budgetRaw - vault.spentRaw : 0n;
  const remainingBasisPoints = vault ? remaining * 10_000n / vault.budgetRaw : 0n;
  const spentPercent = vault ? Number(vault.spentRaw * 100n / vault.budgetRaw) : 0;
  const budgetLevel = vault && remaining * 100n < vault.budgetRaw * 15n ? "low"
    : vault && remaining * 100n < vault.budgetRaw * 40n ? "warning" : "healthy";
  const status = !vault ? "Not created" : vault.revoked ? "Revoked" : now >= vault.expiryUnix ? "Expired" : "Active";
  const hasBalance = vault && (vault.inputBalanceRaw > 0n || vault.outputBalanceRaw > 0n);
  const hasInput = !!vault && vault.inputBalanceRaw > 0n;
  const secondsLeft = vault ? (vault.expiryUnix > now ? vault.expiryUnix - now : 0n) : 0n;
  const lifePercent = vault ? Math.min(100, Number(secondsLeft * 100n / VAULT_LIFETIME)) : 0;
  const locked = !!busy || agentBusy;
  const blocked = activity.filter((item) => !item.ok).length;
  const swaps = activity.filter((item) => details.current.get(item.signature)?.label === "Agent swap");
  const allowedSwaps = swaps.filter((item) => item.ok).length;
  // Oldest → newest for the chart; activity arrives newest first.
  const bars: TradeBar[] = swaps.slice(0, 16).reverse().map((item) => ({
    amount: Number((details.current.get(item.signature)?.amount ?? "0").replace(/[^0-9.]/g, "")) || 0,
    ok: item.ok, error: item.error, time: timeLabel(item.blockTime),
  }));
  const capUi = vault ? Number(rawAmountToUi(vault.maxTradeRaw, 6)) : 50;
  // A revoked or expired vault is finished: nothing is "next" except starting over.
  const finished = !!vault && (vault.revoked || status === "Expired");
  const step1 = vault ? "done" : "next";
  const step2 = hasInput ? "done" : vault && !finished ? "next" : "todo";
  const step3 = swaps.length > 0 ? "done" : hasInput && !finished ? "next" : "todo";
  const guardLead = !vault ? <>No vault yet. Create one and the guardrails switch on.</>
    : vault.revoked ? <>Agent is <strong>revoked</strong>. It can no longer trade; your funds stay withdrawable.</>
    : status === "Expired" ? <>Trading permission has <strong>expired</strong>. Withdraw any time.</>
    : <>Agent may spend up to <strong>{amount(vault.maxTradeRaw)} testUSDC</strong> per trade.</>;

  /* ---- sidebar CTA + rail ---- */
  const busyProps = (label: string) => busy === label ? { "data-busy": "true" as const, "aria-busy": true as const } : {};
  const cta = <>
    {connection.faucet && <button disabled={locked} {...busyProps("Get testUSDC")} onClick={() => void run("Get testUSDC", connection.faucet!)}><Icon name="coins" size={16} />Get 1,000 testUSDC</button>}
    <button className="primary" disabled={!ready || locked} {...busyProps("New demo vault")} onClick={() => void newDemo()}><Icon name="sparkle" size={16} />New demo vault</button>
    <span className="sidebar-hint">One click: creates a fresh vault and adds 1,000 testUSDC.</span>
  </>;

  const rail = <>
    <div className="rail-top">{toolbar}<span className="avatar" title={owner.toBase58()} aria-label={`Owner ${owner.toBase58()}`}>{owner.toBase58().slice(0, 2).toUpperCase()}</span></div>
    <section className="rail-card tinted" aria-labelledby="guard-title">
      <div className="rail-heading"><h2 id="guard-title">Guardrails</h2><span className="rail-badge"><Icon name="shield" size={16} /></span></div>
      <p className="rail-lead">{guardLead}</p>
      <p className="rail-sub">Enforced by the blockchain itself. The agent cannot change or get around them.</p>
      <div className="guard-rows">
        <div className="guard-row"><span className="label">Per-trade cap</span><span className="value">{vault ? amount(vault.maxTradeRaw) : "50"}<small>testUSDC</small></span></div>
        <div className="guard-row"><span className="label">Total budget</span><span className="value">{vault ? amount(vault.budgetRaw) : "100"}<small>testUSDC</small></span></div>
        <div className="guard-row"><span className="label">Spent so far</span><span className={`value ${vault ? "" : "placeholder"}`} data-testid="spent">{vault ? amount(vault.spentRaw) : "—"}<small>testUSDC</small></span>
          <div className={`meter ${budgetLevel}`} role="img" aria-label={vault ? `${spentPercent}% of the budget spent` : "No vault"}><span style={{ width: `${spentPercent}%` }} /></div></div>
        <div className="guard-row"><span className="label">Time left</span><span className="value" data-testid="expiry">{vault ? countdown(vault.expiryUnix, now) : "1 hour, from creation"}</span>
          <div className="meter neutral" role="img" aria-label={vault ? `${lifePercent}% of the hour remaining` : "No vault"}><span style={{ width: `${lifePercent}%` }} /></div></div>
        <div className="guard-row"><span className="label">Output goes to</span><span className="value"><Icon name="lock" size={14} /> This vault only</span></div>
      </div>
    </section>
    <section className="rail-card" aria-labelledby="chart-title">
      <div className="rail-heading"><h2 id="chart-title">Agent requests vs cap</h2></div>
      <div className="chart-hero"><strong>{blocked}</strong><small>blocked · {swaps.length} {swaps.length === 1 ? "request" : "requests"} so far</small></div>
      <TradeBars trades={bars} cap={capUi} unit="testUSDC" />
      <div className="chart-legend" aria-hidden="true"><span><i />Allowed</span><span><i className="bad" />Blocked by Aegis</span></div>
    </section>
    <section className="rail-card" aria-labelledby="keys-title">
      <div className="rail-heading"><h2 id="keys-title">Addresses</h2></div>
      <div className="keys">
        <KeyRow label="Owner" value={owner.toBase58()} />
        <KeyRow label="Agent" value={agent.toBase58()} note={vault?.revoked ? "revoked" : undefined} />
        {vault && <KeyRow label="Vault" value={vault.address.toBase58()} />}
      </div>
    </section>
  </>;

  return <Shell active={active} cta={cta} rail={narrow ? undefined : rail}>
    {narrow && <div className="rail-top">{toolbar}</div>}
    <div className="content-top">
      <div><p className="eyebrow">{environmentName(environment)} · Test money, no real value</p>
        <h1>AI agents can be tricked. Aegis still enforces the limits.</h1></div>
      {swaps.length > 0 && <span className="count-chip"><strong className={blocked === 0 ? "zero" : ""}>{blocked}</strong>{blocked === 1 ? "attack blocked" : "attacks blocked"}</span>}
    </div>
    <div className="dashboard-notice">
      {busy ? <Notice tone="busy" message={busy === "Create vault" ? "Creating your vault…" : busy === "Fund vault" ? "Adding 1,000 testUSDC…" : busy === "New demo vault" ? "Creating and funding a demo vault…" : busy === "Withdraw all" ? "Moving everything back to your wallet…" : busy === "Revoke agent" ? "Stopping the agent…" : `${busy}…`} />
        : notice && (notice.ok
          ? <Notice tone="success" message={notice.text} />
          : <Notice tone="error" message={notice.text} onDismiss={() => setNotice(null)} />)}
    </div>

    <section id="overview" className="tiles" aria-label="Vault at a glance">
      <Tile tone="lavender" icon="wallet" label="In the vault" value={vault ? amount(vault.inputBalanceRaw) : "0"} unit="testUSDC" testId="input-balance"
        sub={<><span className="token-dot" aria-hidden="true" />{hasInput ? "Ready for the agent to trade" : "Fund the vault to start"}</>} />
      <Tile tone="mist" icon="coins" label="Received from trades" value={vault ? amount(vault.outputBalanceRaw, 9) : "0"} unit="testSOL" testId="output-balance"
        sub={<><span className="token-dot sol" aria-hidden="true" />{vault ? "100 testUSDC buys 1 testSOL" : "Nothing received yet"}</>} />
      <Tile tone="mint" icon="chart" label="Budget left" value={vault ? amount(remaining) : "0"} unit="testUSDC" testId="remaining-budget">
        <div className={`budget-section ${budgetLevel}`}>
          <progress aria-label="Remaining budget" aria-valuetext={vault ? `${amount(remaining)} of ${amount(vault.budgetRaw)} testUSDC remaining` : "No vault"} value={remainingBasisPoints.toString()} max="10000" />
          <span className="budget-number">{vault ? <><strong>{amount(vault.spentRaw)}</strong> spent of {amount(vault.budgetRaw)} total</> : "Create a vault to activate"}</span>
        </div>
      </Tile>
      <Tile tone="cream" icon="shield" label="Attacks blocked" value={String(blocked)} subTone={blocked > 0 ? "good" : undefined}
        sub={<><Icon name={blocked > 0 ? "check" : "info"} size={14} />{swaps.length === 0 ? "No agent requests yet" : `${allowedSwaps} ${allowedSwaps === 1 ? "trade" : "trades"} allowed`}</>} />
    </section>

    <section id="vault" className="card vault-card" aria-labelledby="vault-title">
      <div className="card-heading"><h2 id="vault-title">Trading vault</h2><span className={`status ${status.toLowerCase().replace(" ", "-")}`} data-testid="vault-status"><span className="small-dot" aria-hidden="true" />{status}</span></div>
      <div className="steps">
        <Step number={1} state={step1} title="Create a vault" text={vault ? "Your vault is open with a 50 testUSDC per-trade cap and a 100 testUSDC total budget." : "Opens a vault with a 50 testUSDC per-trade cap and a 100 testUSDC total budget. Or use New demo vault for both steps at once."}>
          <button className={step1 === "next" ? "primary" : ""} disabled={!ready || !!vault || locked} {...busyProps("Create vault")} onClick={() => void create()}>Create vault</button>
        </Step>
        <Step number={2} state={step2} title="Add 1,000 testUSDC" text={finished ? `This vault is ${vault!.revoked ? "revoked" : "expired"}, so new money would just sit there. Withdraw what is left, then start a New demo vault from the sidebar.` : "Test money only. The agent can trade with it, but never beyond the guardrails."}>
          <button className={step2 === "next" ? "primary" : ""} disabled={!vault || locked} {...busyProps("Fund vault")} onClick={() => void fund()}>Fund 1,000</button>
        </Step>
        <Step number={3} state={step3} title="Try the agent" text="Run a normal trade, then try to trick it. Anything outside the rules is blocked on-chain.">
          <a className="step-ok" href="#agent">Go to agent <Icon name="arrow" size={14} /></a>
        </Step>
      </div>
      <div className="owner-controls">
        <p>{!vault ? <><strong>Owner controls.</strong> Once your vault exists you can stop the agent or take everything out at any moment.</> : <><strong>Owner controls.</strong> You can stop the agent or take everything out at any moment.</>}</p>
        <div className="buttons">
          <button className="danger" disabled={!vault || vault.revoked || locked} {...busyProps("Revoke agent")} onClick={() => void revoke()}>Revoke agent</button>
          <button disabled={!hasBalance || locked} {...busyProps("Withdraw all")} onClick={() => void withdraw()}>Withdraw all</button>
        </div>
      </div>
      {vault && <p className="vault-address"><Icon name="vault" size={14} />Vault <code title={vault.address.toBase58()} aria-label={vault.address.toBase58()}>{shorten(vault.address.toBase58())}</code></p>}
    </section>

    {narrow && <div className="rail rail--inline">{rail}</div>}

    {environment !== "mock" ? <AgentConsole environment={environment} walletMode={connection.walletMode} key={address.current?.toBase58()} vault={vault} disabled={!!busy} onBusy={setAgentBusy} onComplete={refresh} />
      : <section id="agent" className="card trade-card" aria-labelledby="trade-title">
        <div><h2 id="trade-title">Try an agent trade</h2><p className="muted">20 testUSDC is within the 50 cap and goes through. Try 60 to watch the cap block it.</p></div>
        <form onSubmit={trade}>
          <label htmlFor="trade-amount">Amount <span>testUSDC</span></label>
          <div className="trade-controls"><input id="trade-amount" inputMode="decimal" value={tradeAmount} onChange={(event) => setTradeAmount(event.target.value)} disabled={!vault || !!busy} autoComplete="off" /><button className="primary" disabled={!vault || !!busy} {...busyProps("Agent trade")} type="submit">Swap</button></div>
        </form>
      </section>}

    <section id="activity" className="card activity-card" aria-labelledby="activity-title">
      <div className="card-heading"><h2 id="activity-title">Vault activity</h2><span className="muted">{activity.length === 0 ? "" : `${activity.length} ${activity.length === 1 ? "event" : "events"}`}</span></div>
      {activity.length === 0 ? <div className="empty-activity"><span aria-hidden="true"><Icon name="activity" /></span><strong>No activity yet</strong><p>Create your vault to begin. Every trade and every blocked attempt will show up here, newest first.</p></div> : <div className="table-scroll"><table>
        <thead><tr><th>Time</th><th>Action</th><th>Amount</th><th>Result</th></tr></thead>
        <tbody>{activity.map((item) => <tr key={item.signature}>
          <td><time>{timeLabel(item.blockTime)}</time></td>
          <td><span className="action-name">{details.current.get(item.signature)?.label ?? "Transaction"}</span>
            {environment !== "mock" ? <a className="signature" title={`${item.signature}${environment === "localnet" ? " · Explorer uses your local chain. Allow local network access if prompted." : " · Solana devnet"}`} aria-label={`View transaction ${item.signature} on Solana Explorer`}
              href={explorerTransactionUrl(item.signature, environment)} target="_blank" rel="noopener noreferrer"><code>{shorten(item.signature)}</code><Icon name="external" size={12} /></a>
              : <code className="signature">{shorten(item.signature)}</code>}</td>
          <td className="activity-amount">{groupThousands(details.current.get(item.signature)?.amount ?? "—")}</td>
          <td><span className={`result ${item.ok ? "ok" : "blocked"}`} title={item.ok ? undefined : item.error}><Icon name={item.ok ? "check" : "x"} size={14} />{item.ok ? "Success" : blockedTitle(item.error ?? "Failed")}</span>
            {!item.ok && vault && <span className="rejection-reason">{rejectionReason(item.error ?? "Failed", vault,
              details.current.get(item.signature)?.amount.replace(/ testUSDC$/, ""))}</span>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    <footer><span>Aegis · Bounded autonomy</span><span>{environmentName(environment)} · Test money, no real value</span></footer>
  </Shell>;
}
