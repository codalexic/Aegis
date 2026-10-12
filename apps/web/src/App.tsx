import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type CSSProperties } from "react";
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
import { TradeBars, type TradeBar } from "./TradeBars";
import { Notice } from "./Notice";
import { Toast, ToastStack } from "./Toast";
import { ProgressButton, Skeleton, VaultSkeleton, LoadingDashboard } from "./Progress";
import { DevnetSolHint } from "./DevnetSolHint";
import { needsFaucet, newFundedDemo, withWalletBalanceRefresh } from "./funding";
import { isWalletDisconnected, isWalletNotReady, WALLET_CHANGED, walletRequestError } from "./wallet-lifecycle";
import { CanonicalSiteNotice } from "./CanonicalSiteNotice";
import { isMobileBrowser, phantomBrowseUrl, PHANTOM_INSTALL_MESSAGE, PHANTOM_MOBILE_MESSAGE } from "./phantom-availability";

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


/* --------------------------------------------------------------------------
   Shell: sidebar · content · rail. Pure layout; all state lives in Dashboard.
   -------------------------------------------------------------------------- */
const NAV = [
  { id: "vault", label: "Vault", icon: "vault" as IconName },
  { id: "agent", label: "Agent", icon: "robot" as IconName },
  { id: "stats", label: "Stats", icon: "chart" as IconName },
  { id: "activity", label: "Activity", icon: "activity" as IconName },
] as const;
type PageId = (typeof NAV)[number]["id"];

const PAGE_TITLE: Record<PageId, string> = {
  vault: "AI agents can be tricked. Aegis still enforces the limits.",
  agent: "Test the agent’s limits.",
  stats: "Requests against the per-trade cap.",
  activity: "Every trade and every blocked attempt.",
};

function pageFromHash(): PageId {
  const hash = typeof window === "undefined" ? "" : window.location?.hash ?? "";
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "overview" || raw === "home") return "vault";
  return NAV.some((item) => item.id === raw) ? raw as PageId : "vault";
}

function replaceSessionRoute(connected: boolean) {
  const hash = connected ? "#/overview" : "";
  if (window.location.hash !== hash) {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
  }
}

/** Hash routes (`#/vault`) so the sidebar opens one page at a time. */
function usePage(): [PageId, (id: PageId) => void] {
  const [page, setPage] = useState<PageId>(pageFromHash);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) window.location.replace(`#/${pageFromHash()}`);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    document.querySelector<HTMLElement>(".content")?.scrollTo({ top: 0 });
  }, [page]);
  const go = useCallback((id: PageId) => {
    const next = `#/${id}`;
    if (window.location.hash !== next) window.location.hash = next;
    else setPage(id);
  }, []);
  return [page, go];
}

function Nav({ active }: { active: string }) {
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; y: number; w: number; h: number; ready: boolean }>({
    x: 0, y: 0, w: 0, h: 0, ready: false,
  });

  const measure = useCallback(() => {
    const nav = navRef.current;
    const link = nav?.querySelector<HTMLElement>("a[aria-current='true']");
    if (!nav || !link) return;
    setPill({ x: link.offsetLeft, y: link.offsetTop, w: link.offsetWidth, h: link.offsetHeight, ready: true });
  }, []);

  useLayoutEffect(() => { measure(); }, [active, measure]);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [measure]);

  const pillStyle = {
    transform: `translate3d(${pill.x}px, ${pill.y}px, 0)`,
    width: pill.w,
    height: pill.h,
  } satisfies CSSProperties;

  return <nav className="nav" aria-label="Sections" ref={navRef}>
    <span className={`nav-pill${pill.ready ? " is-ready" : ""}`} style={pillStyle} aria-hidden="true" />
    {NAV.map((item) => (
      <a key={item.id} href={`#/${item.id}`} aria-current={active === item.id ? "true" : undefined}>
        <Icon name={item.icon} size={18} />{item.label}
      </a>
    ))}
  </nav>;
}

function Shell({ active, cta, rail, hideNav, children }: {
  active: string; cta?: ReactNode; rail?: ReactNode; hideNav?: boolean; children: ReactNode;
}) {
  if (hideNav) {
    return <div className="shell shell--start"><main className="content">{children}</main></div>;
  }
  return <div className={`shell shell--dark${rail ? "" : " shell--no-rail"}`}>
    <aside className="sidebar">
      <a className="brand" href="#/vault" aria-label="Aegis home"><Logo size={30} withWordmark /></a>
      <Nav active={active} />
      <div className="sidebar-foot">
        {cta}
      </div>
    </aside>
    <main className="content">{children}</main>
    {rail ? <aside className="rail">{rail}</aside> : null}
  </div>;
}

export function App({
  environment = import.meta.env.AEGIS_ENV as AegisEnvironment,
  walletMode = import.meta.env.AEGIS_WALLET === true,
}: { environment?: AegisEnvironment; walletMode?: boolean } = {}) {
  const wallet = useWallet();
  const walletAddress = wallet.publicKey?.toBase58();
  const adapter = wallet.wallet?.adapter;
  const previousWalletAddress = useRef(walletAddress);
  const generation = useRef(0);
  const [revision, setRevision] = useState(0);
  const [changed, setChanged] = useState(false);
  const [requestError, setRequestError] = useState<Error | null>(null);
  const [walletNotReady, setWalletNotReady] = useState(false);
  useLayoutEffect(() => {
    const switched = previousWalletAddress.current !== walletAddress;
    previousWalletAddress.current = walletAddress;
    if (!walletMode) return;
    // OwnerApp remounts on wallet changes, clearing page state. Replace its
    // route before the new dashboard loads, but preserve connected deep links.
    if (!walletAddress || switched) replaceSessionRoute(!!walletAddress);
    if (walletAddress) return;
    const clearRoute = () => replaceSessionRoute(false);
    window.addEventListener("hashchange", clearRoute);
    return () => window.removeEventListener("hashchange", clearRoute);
  }, [walletMode, walletAddress]);
  useEffect(() => {
    if (!adapter) return;
    setRevision(generation.current);
    const reset = (disconnected: boolean) => {
      // Invalidate work synchronously with the event, before React renders.
      if (walletMode) replaceSessionRoute(!disconnected);
      setRevision(++generation.current);
      setChanged(disconnected);
      setRequestError(null);
      setWalletNotReady(false);
    };
    const onConnect = () => reset(false);
    const onDisconnect = () => reset(true);
    const onReadyStateChange = () => setWalletNotReady(false);
    adapter.on("connect", onConnect);
    adapter.on("disconnect", onDisconnect);
    adapter.on("readyStateChange", onReadyStateChange);
    return () => {
      ++generation.current;
      adapter.off("connect", onConnect);
      adapter.off("disconnect", onDisconnect);
      adapter.off("readyStateChange", onReadyStateChange);
    };
  }, [adapter, walletMode]);

  const isCurrent = useCallback(() => !walletMode || (generation.current === revision
    && adapter?.publicKey?.toBase58() === walletAddress), [walletMode, revision, adapter, walletAddress]);
  const requestWallet = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    const started = generation.current;
    setRequestError(null);
    try { return await action(); }
    catch (error) {
      if (generation.current === started && !isWalletDisconnected(error)) {
        if (isWalletNotReady(error)) setWalletNotReady(true);
        else setRequestError(walletRequestError(error));
      }
      throw error;
    }
  }, []);
  return <>
    <OwnerApp key={`${environment}:${walletMode ? `${walletAddress}:${revision}` : "server"}`}
      environment={environment} walletMode={walletMode} wallet={wallet} changed={changed} walletNotReady={walletNotReady}
      isCurrent={isCurrent} requestWallet={requestWallet} requestError={requestError} dismissRequestError={() => setRequestError(null)} />
  </>;
}

function OwnerApp({ environment, walletMode, wallet, changed, walletNotReady, isCurrent, requestWallet, requestError, dismissRequestError }: {
  environment: AegisEnvironment; walletMode: boolean; wallet: ReturnType<typeof useWallet>; changed: boolean; walletNotReady: boolean;
  isCurrent(): boolean; requestWallet<T>(action: () => Promise<T>): Promise<T>;
  requestError: Error | null; dismissRequestError(): void;
}) {
  const [connection, setConnection] = useState<DashboardConnection | null>(null);
  const [actionsBusy, setActionsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isCurrent();
    setConnection(null); setError(null);
    if (walletMode && (!wallet.publicKey || !wallet.signTransaction)) return;
    const pending = walletMode ? connectWalletDashboard(environment as "localnet" | "devnet", {
      publicKey: wallet.publicKey!, signTransaction: async (transaction) => {
        if (!current()) throw new DOMException("Wallet changed.", "AbortError");
        const signed = await wallet.signTransaction!(transaction);
        if (!current()) throw new DOMException("Wallet changed.", "AbortError");
        return signed;
      },
    }, controller.signal) : connectDashboard(environment);
    void pending.then((value) => { if (current()) setConnection(value); })
      .catch((reason: unknown) => {
        if (current() && !isWalletDisconnected(reason)) setError(reason instanceof Error ? reason.message : "Connection failed.");
      });
    return () => controller.abort();
  }, [environment, walletMode, wallet.publicKey, wallet.signTransaction, isCurrent, requestWallet]);

  // WalletProviderBase keeps readyState current via the adapter's readyStateChange event.
  const readyState = wallet.wallet?.readyState ?? "Unsupported";
  const mobile = walletMode && isMobileBrowser();
  const needsPhantom = walletMode && !wallet.connected && (walletNotReady
    || readyState === "NotDetected" || readyState === "Unsupported" || (mobile && readyState === "Loadable"));
  const walletControl = (className: string) => walletMode && <div className="wallet-control">{needsPhantom
    ? <a className={className} href={mobile ? phantomBrowseUrl(window.location.href, import.meta.env.AEGIS_PUBLIC_ORIGIN) : "https://phantom.com/download"}
      target={mobile ? undefined : "_blank"} rel={mobile ? undefined : "noopener noreferrer"}>
      <Icon name="wallet" size={16} />{mobile ? "Open in Phantom" : "Install Phantom"}
    </a>
    : <ProgressButton type="button" className={className} busy={wallet.connecting || wallet.disconnecting} progress={wallet.disconnecting ? "Disconnecting…" : "Connecting…"} disabled={actionsBusy} onClick={() => {
    void (wallet.connected ? wallet.disconnect() : requestWallet(() => wallet.connect())).catch(() => {});
  }}>
    <Icon name="wallet" size={16} />{wallet.connected ? "Disconnect" : "Connect wallet"}
  </ProgressButton>}
  </div>;
  const siteNotice = environment === "devnet" && walletMode ? <CanonicalSiteNotice /> : null;
  const startBar = <header className="start-bar">
    <a className="brand start-brand" href="/" aria-label="Aegis home"><Logo size={36} withWordmark /></a>
    <div className="rail-top">{walletControl("start-connect")}</div>
  </header>;

  if (!connection) {
    const waitingForWallet = walletMode && (!wallet.connected || !wallet.publicKey);
    return <Shell active="vault" hideNav>
      <div className={waitingForWallet ? "start" : "start connecting-screen"}>
        {startBar}
        {siteNotice}
        <ToastStack>{requestError && <Toast tone="error" message={requestError} onDismiss={dismissRequestError} />}</ToastStack>
        <span className="sr-only" role="status" aria-live="polite">{wallet.connecting ? "Approve connection in Phantom…" : wallet.disconnecting ? "Disconnecting wallet…" : ""}</span>
        {waitingForWallet ? <>
          <div className="start-hero">
            <h1>AI agents can be tricked. Aegis still enforces the limits.</h1>
            {error
              ? <Notice tone="error" message={error} />
              : <p className="connecting-hint" role="status">{needsPhantom ? (mobile ? PHANTOM_MOBILE_MESSAGE : PHANTOM_INSTALL_MESSAGE) : changed ? WALLET_CHANGED : "Devnet SOL covers transaction fees."}</p>}
          </div>
          {environment === "devnet" && <TryIt />}
        </> : error
          ? <div className="connecting"><Notice tone="error" message={error} /></div>
          : <LoadingDashboard />}
      </div>
    </Shell>;
  }
  return <Dashboard key={`${environment}:${connection.owner.toBase58()}`} connection={connection} isCurrent={isCurrent} onBusyChange={setActionsBusy} siteNotice={siteNotice} toolbar={walletControl("start-connect rail-action")}
    walletName={wallet.wallet?.adapter.name} walletIcon={wallet.wallet?.adapter.icon} />;
}

const TRY_STEPS: { title: string; body: ReactNode }[] = [
  {
    title: "Install Phantom",
    body: <>Download from <a href="https://phantom.com/download" target="_blank" rel="noreferrer">phantom.com</a></>,
  },
  {
    title: "Switch to devnet",
    body: "In Phantom: Settings → Developer Settings → Testnet Mode → Solana Devnet.",
  },
  {
    title: "Connect here",
    body: "Use the top-right button; approve in Phantom.",
  },
  {
    title: "Try the demo",
    body: "Create and fund a vault, then test the agent.",
  },
];

function TryIt() {
  return <aside className="try-it" aria-labelledby="try-it-title">
    <header className="try-it-head">
      <h2 id="try-it-title">How to get started?</h2>
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
    <p className="try-it-foot">Need devnet SOL? Use the <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">Solana Faucet</a>.</p>
  </aside>;
}

/* --------------------------------------------------------------------------
   Small presentational pieces
   -------------------------------------------------------------------------- */
function Tile({ tone, icon, label, value, unit, sub, subTone, testId, children, loading }: {
  tone: "lavender" | "mist" | "mint" | "cream"; icon: IconName; label: string; value: string; unit?: string;
  sub?: ReactNode; subTone?: "good" | "bad" | "warning"; testId?: string; children?: ReactNode; loading?: boolean;
}) {
  return <div className={`tile tile--${tone}`}>
    <span className="tile-icon"><Icon name={icon} size={22} /></span>
    <span className="tile-label">{label}</span>
    {loading ? <><Skeleton className="skeleton-value" /><Skeleton /></> : <>
    <div className="tile-value"><strong data-testid={testId} className={value === "—" ? "placeholder" : undefined}>{value}</strong>{unit && <small>{unit}</small>}</div>
    {sub && <span className={`tile-sub ${subTone ?? ""}`}>{sub}</span>}
    {children}</>}
  </div>;
}

function Step({ number, state, title, text, children }: { number: number; state: "done" | "next" | "todo"; title: string; text: ReactNode; children: ReactNode }) {
  return <div className={`step ${state}`}>
    <span className="step-num" aria-hidden="true">{state === "done" ? <Icon name="check" size={18} /> : number}</span>
    <div><strong>{state === "done" && <span className="sr-only">Done: </span>}{title}</strong><p>{text}</p></div>
    {children}
  </div>;
}

export function FundingStep({ state, text, balance, hasFaucet, hasVault, finished, locked, busy, onFaucet, onFund, onNewDemo }: {
  state: "done" | "next" | "todo"; text: string; balance: bigint | null; hasFaucet: boolean;
  hasVault: boolean; finished: boolean; locked: boolean; busy: string | null; onFaucet(): void; onFund(): void; onNewDemo(): void;
}) {
  if (finished) return <Step number={2} state={state} title="Add testUSDC"
    text="Start again with a funded vault.">
    <ProgressButton className="primary" disabled={locked} busy={busy === "New demo vault"} progress="Setting up…"
      onClick={onNewDemo}>New demo vault</ProgressButton>
  </Step>;
  const getTokens = busy === "Get testUSDC" || (busy !== "Fund vault" && needsFaucet(balance, hasFaucet));
  const isBusy = busy === (getTokens ? "Get testUSDC" : "Fund vault");
  return <Step number={2} state={state} title="Add testUSDC" text={<>
    {text}<br />Wallet: {balance === null ? "—" : amount(balance)} testUSDC
  </>}>
    <ProgressButton className={state === "next" ? "primary" : ""} disabled={!hasVault || locked}
      busy={isBusy} progress={getTokens ? "Getting tokens…" : "Funding…"}
      onClick={getTokens ? onFaucet : onFund}>{getTokens ? "Get 1,000 testUSDC" : "Fund 1,000"}</ProgressButton>
  </Step>;
}

/** Connected owner account: the wallet logo; clicking it copies the owner address. */
export function AccountChip({ address, walletIcon }: { address: string; walletName?: string; walletIcon?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1500); return () => window.clearTimeout(timer); }, [copied]);
  const copy = () => { void navigator.clipboard?.writeText(address).then(() => setCopied(true)).catch(() => {}); };
  return <div className="account-chip">
    <button type="button" className="account-chip-button" aria-label={`Owner ${address}`} onClick={copy}>
      {walletIcon ? <img src={walletIcon} alt="" width={20} height={20} /> : <Icon name="wallet" size={16} />}
    </button>
    <span className={`account-copied${copied ? " is-visible" : ""}`} role="status" aria-live="polite">{copied ? "Copied!" : ""}</span>
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
const alwaysCurrent = () => true;
export function Dashboard({ connection, toolbar, isCurrent = alwaysCurrent, onBusyChange, siteNotice, walletName, walletIcon }: {
  connection: DashboardConnection; toolbar: ReactNode; isCurrent?(): boolean; onBusyChange?(busy: boolean): void;
  siteNotice?: ReactNode; walletName?: string; walletIcon?: string;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const current = useCallback(() => mounted.current && isCurrent(), [isCurrent]);
  const { client, owner, agent, environment } = connection;
  const address = useRef<PublicKey | null>(connection.initialVault);
  const details = useRef(new Map<string, ActionDetail>());
  const running = useRef(false);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const balanceRequest = useRef(0);
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
  const [page, go] = usePage();
  const [activityReady, setActivityReady] = useState(false);
  const [stage, setStage] = useState("");
  const [reloading, setReloading] = useState(false);
  const loading = !ready || reloading;
  useEffect(() => { onBusyChange?.(!!busy || agentBusy || !ready); }, [busy, agentBusy, ready, onBusyChange]);
  const reportProgress = (text: string) => { if (current()) setStage(text); };

  const refreshWalletBalance = useCallback(async () => {
    if (!current()) return;
    const request = ++balanceRequest.current;
    const balance = await connection.getWalletBalance?.().catch(() => null) ?? null;
    // A slow poll started before confirmation must not overwrite the fresh balance.
    if (current() && request === balanceRequest.current) setWalletBalance(balance);
  }, [connection, current]);

  const refreshState = useCallback(async () => {
    if (!current()) return;
    setNow(nowUnix());
    await refreshWalletBalance();
    if (!current() || !address.current) return;
    const selected = address.current;
    try {
      const state = await client.getVault(selected);
      if (!current() || address.current !== selected) return;
      currentState.current = state;
      setVault(state);
      setReady(true);
    } catch (error) {
      if (!current() || address.current !== selected) return;
      if (error instanceof Error && error.message === "VaultNotFound") {
        currentState.current = null;
        setVault(null); setActivity([]); setReady(true); setActivityReady(true); return;
      }
      throw error;
    }
  }, [client, refreshWalletBalance, current]);

  const refreshActivity = useCallback(async () => {
    const selected = address.current, state = currentState.current;
    if (!current() || !selected || !state || !state.address.equals(selected)) return;
    const history = await client.listActivity(selected);
    if (!current() || address.current !== selected) return;
    const read = async (item: Activity) => {
      if (!current() || address.current !== selected) return;
      const detail = await connection.readDetail!(item.signature, state);
      if (current() && detail && address.current === selected) details.current.set(item.signature, detail);
    };
    if (connection.readDetail) {
      const missing = history.filter((item) => !details.current.has(item.signature));
      if (environment === "devnet") {
        for (const item of missing) await read(item);
      } else await Promise.all(missing.map(read));
    }
    if (current() && address.current === selected) { setActivity(history); setActivityReady(true); }
  }, [client, connection, environment, current]);

  const refresh = useCallback(async () => {
    if (!current()) return;
    if (environment === "devnet") { await polling.current?.refresh(); return; }
    if (refreshing.current) return;
    refreshing.current = true;
    try { await refreshState(); await refreshActivity(); }
    finally { refreshing.current = false; }
  }, [environment, refreshState, refreshActivity, current]);

  const refreshAfterAgent = async () => {
    if (current()) setReloading(true);
    try { await refresh(); }
    finally { if (current()) setReloading(false); }
  };

  useEffect(() => {
    const onError = (error: unknown) => {
      if (!current() || isWalletDisconnected(error)) return;
      setNotice((current) => current ?? {
        ok: false, text: isRateLimited(error) ? RPC_RATE_LIMITED : environment === "localnet"
          ? "Lost contact with the test chain. Is the local validator still running?"
          : "Could not refresh the vault. Retrying…",
      });
    };
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
  }, [refresh, refreshState, refreshActivity, environment, current]);

  useEffect(() => {
    if (!notice?.ok) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function track<T extends TxResult>(result: T, detail: ActionDetail): T {
    if (!current()) throw new DOMException("Wallet changed.", "AbortError");
    if (result.signature) details.current.set(result.signature, detail);
    if (!result.ok) throw Object.assign(new Error(result.error), { detail: result.detail });
    return result;
  }

  async function run(label: string, action: () => Promise<string>) {
    if (!current() || running.current || agentBusy) return;
    running.current = true;
    setBusy(label);
    setStage(label === "Get testUSDC" ? "Getting testUSDC…" : label === "New demo vault" ? "Setting up demo vault…" : connection.walletMode ? "Preparing…" : `${label}…`);
    setNotice(null);
    try {
      // Keep actions locked through a fresh read, even if polling is hidden or
      // waiting for activity history. Also reconcile partial successes/failures.
      const text = await withWalletBalanceRefresh(action, async () => {
        if (current()) setStage("Refreshing vault…");
        await refreshWalletBalance();
      });
      if (current()) setNotice({ ok: true, text });
    } catch (error) {
      if (current() && !isWalletDisconnected(error)) setNotice({ ok: false, text: error });
    } finally {
      try { await refresh(); } catch { if (current()) setNotice((notice) => notice ?? { ok: false, text: "Could not refresh the vault. Retrying…" }); }
      running.current = false;
      if (current()) { setBusy(null); setStage(""); }
    }
  }

  const create = () => run("Create vault", async () => {
    const result = track(await connection.create(reportProgress), { label: "Create vault", amount: "0" });
    if (!result.vault) throw new Error("No vault address was returned.");
    address.current = result.vault;
    setActivityReady(false);
    return "Vault created. Next: add 1,000 testUSDC.";
  });

  const fund = () => run("Fund vault", async () => {
    track(await connection.fund(address.current!, reportProgress), { label: "Fund vault", amount: "1,000 testUSDC" });
    return `Added 1,000 testUSDC. Next: ${environment === "mock" ? "try a trade" : "try the agent"} below.`;
  });

  const newDemo = () => run("New demo vault", async () => {
    const result = await newFundedDemo(connection, walletBalance, refreshWalletBalance, reportProgress);
    if (!current()) return "";
    if (result.vault) {
      address.current = result.vault;
      details.current.clear();
      setVault(null);
      setActivity([]);
      setReady(false);
      setActivityReady(false);
    }
    if (result.createSignature) track({ ok: true, signature: result.createSignature }, { label: "Create vault", amount: "0" });
    track(result, { label: "Fund vault", amount: "1,000 testUSDC" });
    if (!result.vault) throw new Error("No vault address was returned.");
    return `Your demo vault is ready with 1,000 testUSDC. Next: ${environment === "mock" ? "try a trade" : "try the agent"} below.`;
  });

  const revoke = () => run("Revoke agent", async () => {
    track(await connection.revoke(address.current!, reportProgress), { label: "Revoke agent", amount: "0" });
    return "Agent revoked. You can still withdraw your funds.";
  });

  const withdraw = () => run("Withdraw all", async () => {
    const state = await client.getVault(address.current!);
    for (const [mint, balance, decimals, symbol] of [
      [state.inputMint, state.inputBalanceRaw, 6, "testUSDC"],
      [state.outputMint, state.outputBalanceRaw, 9, "testSOL"],
    ] as const) {
      if (balance > 0n) track(await connection.withdraw(state.address, mint, balance, (stage) => reportProgress(`${symbol} · ${stage}`)), {
        label: "Withdraw", amount: `${amount(balance, decimals)} ${symbol}`,
      });
    }
    return "Everything is back in your wallet.";
  });

  function trade(event: FormEvent) {
    event.preventDefault();
    if (finished) return;
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
  const status = !ready ? "Loading" : !vault ? "Not created" : vault.revoked ? "Revoked" : now >= vault.expiryUnix ? "Expired" : "Active";
  const hasBalance = vault && (vault.inputBalanceRaw > 0n || vault.outputBalanceRaw > 0n);
  const hasInput = !!vault && vault.inputBalanceRaw > 0n;
  const secondsLeft = vault ? (vault.expiryUnix > now ? vault.expiryUnix - now : 0n) : 0n;
  const lifePercent = vault ? Math.min(100, Number(secondsLeft * 100n / VAULT_LIFETIME)) : 0;
  const locked = !!busy || agentBusy || loading;
  const swaps = activityReady ? activity.filter((item) => details.current.get(item.signature)?.label === "Agent swap") : [];
  const allowedSwaps = swaps.filter((item) => item.ok).length;
  const blocked = swaps.length - allowedSwaps;
  // Oldest → newest for the chart; activity arrives newest first.
  const bars: TradeBar[] = swaps.slice(0, 16).reverse().map((item) => ({
    amount: Number((details.current.get(item.signature)?.amount ?? "0").replace(/[^0-9.]/g, "")) || 0,
    ok: item.ok, error: item.error, time: timeLabel(item.blockTime),
  }));
  const capUi = vault ? Number(rawAmountToUi(vault.maxTradeRaw, 6)) : 50;
  // A revoked or expired vault is finished: nothing is "next" except starting over.
  const finished = !!vault && (vault.revoked || status === "Expired");
  const hasFunded = !!vault && (hasInput || vault.spentRaw > 0n || vault.outputBalanceRaw > 0n ||
    activity.some((item) => item.ok && details.current.get(item.signature)?.label === "Fund vault"));
  const hasAgentRequest = !!vault && (vault.spentRaw > 0n || swaps.length > 0);
  const step1 = !ready ? "todo" : vault ? "done" : "next";
  const step2 = !ready ? "todo" : hasFunded ? "done" : vault && !finished ? "next" : "todo";
  const step3 = !ready ? "todo" : hasAgentRequest ? "done" : hasInput && !finished ? "next" : "todo";
  const stepsDone = (step1 === "done" ? 1 : 0) + (step2 === "done" ? 1 : 0) + (step3 === "done" ? 1 : 0);
  const guardLead = !ready ? <>Loading vault state…</>
    : !vault ? <>Applies once the vault is created.</>
    : vault.revoked ? <>Agent is <strong>revoked</strong>.</>
    : status === "Expired" ? <>Trading permission has <strong>expired</strong>.</>
    : null;

  const cta = <>
    <ProgressButton className="primary" disabled={!ready || locked} busy={busy === "New demo vault"} progress="Setting up…" onClick={() => void newDemo()}><Icon name="sparkle" size={16} />New demo vault</ProgressButton>
  </>;

  const pageLoading = <p className="page-loading" role="status">Loading…</p>;

  return <Shell active={page} cta={cta}>
    <div className="page-view" key={page}>
    <div className="content-top">
      <div>
        <h1>{PAGE_TITLE[page]}</h1>
      </div>
      <div className="content-toolbar">
        {toolbar}
        <AccountChip address={owner.toBase58()} walletName={walletName} walletIcon={walletIcon} />
      </div>
    </div>
    {siteNotice}
    <ToastStack>
      {busy ? <Toast tone="busy" message={`${busy} · ${stage}`} />
        : notice && (notice.ok
          ? <Toast tone="success" message={notice.text} />
          : <Toast tone="error" message={notice.text} onDismiss={() => setNotice(null)} />)}
      {!busy && !ready && <Toast tone="busy" message="Loading vault…" />}
    </ToastStack>
    {connection.getWalletSolBalance && <DevnetSolHint readBalance={connection.getWalletSolBalance} />}

    {page === "vault" && <>
      <section id="overview" className="tiles" aria-label="Vault at a glance" aria-busy={loading}>
        <Tile loading={loading} tone="cream" icon="wallet" label="In the vault" value={vault ? amount(vault.inputBalanceRaw) : "0"} unit="testUSDC" testId="input-balance"
          sub={<><span className="token-dot" aria-hidden="true" />{hasInput ? "Ready for the agent to trade" : "Fund the vault to start"}</>} />
        <Tile loading={loading} tone="cream" icon="coins" label="Received from trades" value={vault ? amount(vault.outputBalanceRaw, 9) : "0"} unit="testSOL" testId="output-balance"
          sub={<><span className="token-dot sol" aria-hidden="true" />{vault ? "100 testUSDC buys 1 testSOL" : "Nothing received yet"}</>} />
        <Tile loading={loading} tone="cream" icon="chart" label="Budget left" value={vault ? amount(remaining) : "0"} unit="testUSDC" testId="remaining-budget">
          <div className={`budget-section ${budgetLevel}`}>
            <progress aria-label="Remaining budget" aria-valuetext={vault ? `${amount(remaining)} of ${amount(vault.budgetRaw)} testUSDC remaining` : "No vault"} value={remainingBasisPoints.toString()} max="10000" />
            <span className="budget-number"></span>
          </div>
        </Tile>
        <Tile loading={loading} tone="cream" icon="shield" label="Attacks blocked" value={activityReady ? String(blocked) : "—"} subTone={blocked > 0 ? "good" : undefined}
          sub={<><Icon name={blocked > 0 ? "check" : "info"} size={14} />{!activityReady ? "Loading activity" : swaps.length === 0 ? "No agent requests yet" : `${allowedSwaps} ${allowedSwaps === 1 ? "trade" : "trades"} allowed`}</>} />
      </section>

      {loading ? <VaultSkeleton /> : <>
      <section className="go-live" aria-labelledby="vault-setup-title">
        <div className="go-live-head">
          <div>
            <div className="go-live-title">
              <h2 id="vault-setup-title">{stepsDone === 3 ? "Vault ready" : "Trading vault"}</h2>
              <span className={`status ${status.toLowerCase().replace(" ", "-")}`} data-testid="vault-status"><span className="small-dot" aria-hidden="true" />{status}</span>
            </div>
            <p className="go-live-lead">{stepsDone === 3
              ? "Try the agent, or revoke and withdraw."
              : "Create and fund a vault, then test the agent."}</p>
          </div>
          <div className="go-live-progress" aria-label={`${stepsDone} of 3 steps done`}>
            <span>{stepsDone} of 3 done</span>
            <div className="go-live-track" aria-hidden="true"><span style={{ width: `${(stepsDone / 3) * 100}%` }} /></div>
          </div>
        </div>
        <div className="steps">
          <Step number={1} state={step1} title={vault ? "Vault created" : "Vault setup"}
            text={vault ? "Your vault is open with a 50 testUSDC per-trade cap and a 100 testUSDC total budget." : ""}>
            <div className="step-action">
              <ProgressButton className={step1 === "next" ? "primary" : ""} disabled={!ready || !!vault || locked} busy={busy === "Create vault"} progress="Creating…" onClick={() => void create()}>Create vault</ProgressButton>
            </div>
          </Step>
          <FundingStep state={step2} balance={walletBalance} hasFaucet={!!connection.faucet} hasVault={!!vault} finished={finished} locked={locked} busy={busy}
            text={needsFaucet(walletBalance, !!connection.faucet) ? (vault ? "Get testUSDC before funding."
                : "Set up your vault first.")
              : "Transfer from your wallet."}
            onFaucet={() => void run("Get testUSDC", connection.faucet!)} onFund={() => void fund()} onNewDemo={() => void newDemo()} />
          <Step number={3} state={step3} title="Try the agent" text="Trade normally, then test an attack.">
            <button type="button" className="step-ok" onClick={() => go("agent")}>Go to agent <Icon name="arrow" size={14} /></button>
          </Step>
        </div>
      </section>

      <div className="panel-grid">
        <section className="rail-card guardrails-card" aria-labelledby="guard-title">
          <div className="rail-heading"><h2 id="guard-title">Guardrails</h2><span className="rail-badge"><Icon name="shield" size={16} /></span></div>
          {guardLead && <p className="rail-lead">{guardLead}</p>}
          <p className="rail-sub">Enforced on-chain. The agent cannot change them.</p>
          <div className="guard-rows">
            <div className="guard-row"><span className="label">Per-trade cap</span><span className="value">{vault ? amount(vault.maxTradeRaw) : "50"}<small>testUSDC</small></span></div>
            <div className="guard-row"><span className="label">Total budget</span><span className="value">{vault ? amount(vault.budgetRaw) : "100"}<small>testUSDC</small></span></div>
            <div className="guard-row"><span className="label">Spent so far</span><span className="value" data-testid="spent">{vault ? amount(vault.spentRaw) : "—"}<small>testUSDC</small></span>
              <div className={`meter ${budgetLevel}`} role="img" aria-label={vault ? `${spentPercent}% of the budget spent` : "No vault"}><span style={{ width: `${spentPercent}%` }} /></div></div>
            <div className="guard-row"><span className="label">Time left</span><span className="value" data-testid="expiry">{vault ? countdown(vault.expiryUnix, now) : "1 hour, from creation"}</span>
              <div className="meter neutral" role="img" aria-label={vault ? `${lifePercent}% of the hour remaining` : "No vault"}><span style={{ width: `${lifePercent}%` }} /></div></div>
            <div className="guard-row guard-row--wide"><span className="label">Output goes to</span><span className="value"><Icon name="lock" size={14} /> This vault only</span></div>
          </div>
        </section>
        <section className="rail-card addresses-card" aria-labelledby="keys-title">
          <div className="rail-heading"><h2 id="keys-title">Addresses</h2></div>
          <div className="keys">
            <KeyRow label="Owner" value={owner.toBase58()} />
            <KeyRow label="Agent" value={agent.toBase58()} note={vault?.revoked ? "revoked" : undefined} />
            {vault && <KeyRow label="Vault" value={vault.address.toBase58()} />}
          </div>
          {vault && <div className="owner-panel">
            <div className="owner-panel-copy">
              <strong>Owner controls.</strong>
              <p>Funds stay withdrawable after revocation or expiry.</p>
            </div>
            <div className="owner-panel-actions">
              <ProgressButton className="danger" disabled={vault.revoked || locked} busy={busy === "Revoke agent"} progress="Revoking…" onClick={() => void revoke()}>Revoke agent</ProgressButton>
              <ProgressButton className="primary" disabled={!hasBalance || locked} busy={busy === "Withdraw all"} progress="Withdrawing…" onClick={() => void withdraw()}>Withdraw all</ProgressButton>
            </div>
          </div>}
        </section>
      </div>
      </>}
    </>}

    {page === "stats" && <section className="rail-card chart-card" aria-labelledby="chart-title">
      <div className="rail-heading">
        <h2 id="chart-title">Agent requests</h2>
        <span className="chart-cap-pill">Per-trade cap</span>
      </div>
      {!ready || !activityReady ? pageLoading : <>
        <div className="chart-stats">
          <div className="chart-stat"><strong>{swaps.length}</strong><span>requests</span></div>
          <div className={`chart-stat${allowedSwaps > 0 ? " is-ok" : ""}`}><strong>{allowedSwaps}</strong><span>allowed</span></div>
          <div className={`chart-stat${blocked > 0 ? " is-bad" : ""}`}><strong>{blocked}</strong><span>blocked</span></div>
        </div>
        {swaps.length > 0 ? <>
          <div className="chart-plot" key={bars.map((b) => `${b.amount}-${b.ok}`).join("|")}>
            <TradeBars trades={bars} cap={capUi} unit="testUSDC" />
          </div>
          <div className="chart-legend" aria-hidden="true">
            <span><i />Allowed</span>
            <span><i className="bad" />Blocked by Aegis</span>
          </div>
        </> : <div className="empty-activity">
          <span aria-hidden="true"><Icon name="chart" /></span>
          <strong>No agent requests yet</strong>
          <p>Run an agent trade to compare requests with the per-trade cap.</p>
          <button type="button" className="primary" onClick={() => go("agent")}>Go to agent <Icon name="arrow" size={14} /></button>
        </div>}
      </>}
    </section>}

    {page === "agent" && (!ready ? pageLoading : environment !== "mock"
      ? <AgentConsole environment={environment} walletMode={connection.walletMode} key={address.current?.toBase58()} vault={vault} finished={finished} disabled={!!busy || loading} onBusy={setAgentBusy} onComplete={refreshAfterAgent} />
      : <section id="agent" className="card trade-card" aria-labelledby="trade-title">
        <div><h2 id="trade-title">Try an agent trade</h2><p className="muted">Try an amount above the per-trade cap.</p></div>
        <form onSubmit={trade}>
          <label htmlFor="trade-amount">Amount <span>testUSDC</span></label>
          <div className="trade-controls"><input id="trade-amount" inputMode="decimal" value={tradeAmount} onChange={(event) => setTradeAmount(event.target.value)} disabled={!vault || finished || !!busy} autoComplete="off" /><ProgressButton className="primary" disabled={!vault || finished || !!busy} busy={busy === "Agent trade"} progress="Swapping…" type="submit">Swap</ProgressButton></div>
        </form>
      </section>)}

    {page === "activity" && <section className="card activity-card" aria-labelledby="activity-title">
      <div className="card-heading"><h2 id="activity-title">Vault activity</h2><span className="muted">{!activityReady || activity.length === 0 ? "" : `${activity.length} ${activity.length === 1 ? "event" : "events"}`}</span></div>
      {!ready || !activityReady ? pageLoading : activity.length === 0 ? <div className="empty-activity activity-in"><span aria-hidden="true"><Icon name="activity" /></span><strong>No activity yet</strong><p>Transactions appear here, newest first.</p></div> : <div className="table-scroll activity-in">
        <table>
          <thead><tr><th>Time</th><th>Action</th><th>Amount</th><th className="activity-result">Result</th></tr></thead>
          <tbody>{activity.map((item, index) => <tr key={item.signature} style={{ ["--i" as string]: index }}>
            <td><time>{timeLabel(item.blockTime)}</time></td>
            <td><span className="action-name">{details.current.get(item.signature)?.label ?? "Transaction"}</span>
              {environment !== "mock" ? <a className="signature" title={`${item.signature}${environment === "localnet" ? " · Explorer uses your local chain. Allow local network access if prompted." : " · Solana devnet"}`} aria-label={`View transaction ${item.signature} on Solana Explorer`}
                href={explorerTransactionUrl(item.signature, environment)} target="_blank" rel="noopener noreferrer"><code>{shorten(item.signature)}</code><Icon name="external" size={12} /></a>
                : <code className="signature">{shorten(item.signature)}</code>}</td>
            <td className="activity-amount">{groupThousands(details.current.get(item.signature)?.amount ?? "0")}</td>
            <td className="activity-result"><span className={`result ${item.ok ? "ok" : "blocked"}`} title={item.ok || !vault ? undefined : rejectionReason(item.error ?? "Failed", vault,
              details.current.get(item.signature)?.amount.replace(/ testUSDC$/, ""))}><Icon name={item.ok ? "check" : "x"} size={14} />{item.ok ? "Success" : blockedTitle(item.error ?? "Failed")}</span></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>}
    </div>
  </Shell>;
}
