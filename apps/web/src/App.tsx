import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import type { AegisEnvironment, Activity, TxResult, VaultState } from "@aegis/sdk";
import { rawAmountToUi } from "../../../packages/sdk/src/amounts";
import { connectDashboard, type DashboardConnection, type Scenario } from "./client";
import type { ActionDetail } from "./activity";
import { AgentConsole, blockedTitle, rejectionReason } from "./AgentConsole";
import { useWallet } from "./wallet-react";
import { connectWalletDashboard } from "./wallet-client";
import { startDashboardPolling } from "./polling";
import { isRateLimited, RPC_RATE_LIMITED } from "../../../packages/sdk/src/errors";
import { explorerTransactionUrl } from "../../../packages/sdk/src/explorer";
import { Icon, type IconName } from "./icons";
import { SiteHeader } from "./SiteHeader";
import { Landing } from "./Landing";
import { Notice } from "./Notice";
import { Toast, ToastStack } from "./Toast";
import { ProgressButton, LoadingDashboard } from "./Progress";
import { TradeBars, type TradeBar } from "./TradeBars";
import { DevnetSolHint } from "./DevnetSolHint";
import { needsFaucet, newFundedDemo, withWalletBalanceRefresh } from "./funding";
import { isWalletDisconnected, isWalletNotReady, WALLET_CHANGED, walletRequestError } from "./wallet-lifecycle";
import { CanonicalSiteNotice } from "./CanonicalSiteNotice";
import { useCopy } from "./use-copy";
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

function replaceSessionRoute(connected: boolean) {
  const hash = connected ? "#/overview" : "";
  if (window.location.hash !== hash) {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
  }
}

function Frame({ actions, links, children }: { actions?: ReactNode; links?: ReactNode; children: ReactNode }) {
  return <div className="db">
    <SiteHeader home={links ? "#/overview" : "/"} links={links} actions={actions} />
    {children}
  </div>;
}

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "agent", label: "AI agent" },
  { id: "analytics", label: "Analytics" },
  { id: "activity", label: "Activity" },
  { id: "vault", label: "Vault" },
] as const;
type PageId = (typeof PAGES)[number]["id"];

function pageLinks(current?: PageId) {
  return PAGES.map((item) => <a key={item.id} href={`#/${item.id}`} aria-current={item.id === current ? "page" : undefined}>
    {item.label}
  </a>);
}

function pageFromHash(): PageId {
  const raw = (typeof window === "undefined" ? "" : window.location?.hash ?? "").replace(/^#\/?/, "");
  return PAGES.some((page) => page.id === raw) ? raw as PageId : "overview";
}

/** Hash routes (`#/agent`) keep each page linkable; the wallet session sets `#/overview` on connect. */
function usePage(): [PageId, (id: PageId) => void] {
  const [page, setPage] = useState<PageId>(pageFromHash);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { window.scrollTo?.({ top: 0 }); }, [page]);
  const go = useCallback((id: PageId) => {
    if (window.location.hash !== `#/${id}`) window.location.hash = `#/${id}`;
    setPage(id);
  }, []);
  return [page, go];
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
  // Once connected, the header's wallet button becomes one pill of the same size:
  // the wallet logo (click copies the address) beside Disconnect, so nothing jumps.
  const headerWallet = walletMode && wallet.connected && wallet.publicKey
    ? <div className="wallet-pill"><AccountChip address={wallet.publicKey.toBase58()} walletIcon={wallet.wallet?.adapter.icon} />{walletControl("site-wallet")}</div>
    : walletControl("site-wallet");

  if (!connection) {
    const waitingForWallet = walletMode && (!wallet.connected || !wallet.publicKey);
    const toasts = <ToastStack>{requestError && <Toast tone="error" message={requestError} onDismiss={dismissRequestError} />}</ToastStack>;
    const walletStatus = <span className="sr-only" role="status" aria-live="polite">{wallet.connecting ? "Approve connection in Phantom…" : wallet.disconnecting ? "Disconnecting wallet…" : ""}</span>;
    if (waitingForWallet) {
      const hint = needsPhantom ? (mobile ? PHANTOM_MOBILE_MESSAGE : PHANTOM_INSTALL_MESSAGE) : changed ? WALLET_CHANGED : null;
      return <Landing walletButton={walletControl}
        status={error ? <Notice tone="error" message={error} /> : hint && <p className="connecting-hint" role="status">{hint}</p>}>
        {siteNotice}{toasts}{walletStatus}
      </Landing>;
    }
    return <Frame actions={headerWallet} links={pageLinks()}>
      <main className="db-main--center">
        {siteNotice}
        {toasts}
        {walletStatus}
        {error
          ? <div className="connecting connecting--error"><Notice tone="error" message={error} /></div>
          : <LoadingDashboard />}
      </main>
    </Frame>;
  }
  return <Dashboard key={`${environment}:${connection.owner.toBase58()}`} connection={connection} isCurrent={isCurrent} onBusyChange={setActionsBusy} siteNotice={siteNotice} toolbar={headerWallet}
    walletIcon={wallet.wallet?.adapter.icon} />;
}

export function FundingStep({ text, balance, hasFaucet, finished, locked, busy, onFaucet, onFund, onNewDemo }: {
  text: string; balance: bigint | null; hasFaucet: boolean; finished: boolean; locked: boolean; busy: string | null; onFaucet(): void; onFund(): void; onNewDemo(): void;
}) {
  if (finished) return <div className="next-action is-centered">
    <ProgressButton className="primary" disabled={locked} busy={busy === "New demo vault"} progress="Setting up…"
      onClick={onNewDemo}>New demo vault</ProgressButton>
  </div>;
  const getTokens = busy === "Get testUSDC" || (busy !== "Fund vault" && needsFaucet(balance, hasFaucet));
  const isBusy = busy === (getTokens ? "Get testUSDC" : "Fund vault");
  return <div className="next-action">
    <p className="next-hint">{text}<br />Wallet: {balance === null ? "—" : amount(balance)} testUSDC</p>
    <ProgressButton className="primary" disabled={locked}
      busy={isBusy} progress={getTokens ? "Getting tokens…" : "Funding…"}
      onClick={getTokens ? onFaucet : onFund}>{getTokens ? "Get 1,000 testUSDC" : "Fund 1,000"}</ProgressButton>
  </div>;
}

function feedEntry(item: Activity, detail: ActionDetail | undefined, vault: VaultState | null): { icon: IconName; tone: "ok" | "bad" | "neutral"; title: string; sub?: string } {
  const what = detail ? groupThousands(detail.amount) : "";
  switch (detail?.label) {
    case "Agent swap": return item.ok
      ? { icon: "swap", tone: "ok", title: `AI traded ${what}`, sub: "Within your rules" }
      : { icon: "shield", tone: "bad", title: `Blocked · ${blockedTitle(item.error ?? "Failed")}`,
        sub: vault ? rejectionReason(item.error ?? "Failed", vault, detail.amount.replace(/ testUSDC$/, "")) : `The AI asked for ${what}` };
    case "Fund vault": return { icon: "coins", tone: item.ok ? "neutral" : "bad", title: item.ok ? `Added ${what}` : "Funding failed" };
    case "Create vault": return { icon: "vault", tone: item.ok ? "neutral" : "bad", title: item.ok ? "Vault created" : "Vault setup failed" };
    case "Withdraw": return { icon: "wallet", tone: item.ok ? "neutral" : "bad", title: item.ok ? `Withdrew ${what}` : "Withdrawal failed" };
    case "Revoke agent": return { icon: "lock", tone: item.ok ? "neutral" : "bad", title: item.ok ? "AI agent stopped" : "Stopping the AI failed" };
    default: return { icon: "activity", tone: item.ok ? "neutral" : "bad", title: item.ok ? "Transaction" : "Transaction failed" };
  }
}

const SVG_ICON = "data:image/svg+xml;base64,";
/** Recolours an SVG wallet logo: first fill (the tile) dark grey, the rest pink. Other formats pass through. */
export function tintWalletIcon(icon: string): string {
  if (!icon.startsWith(SVG_ICON)) return icon;
  let svg: string;
  try { svg = atob(icon.slice(SVG_ICON.length)); } catch { return icon; }
  if (!svg.includes("<svg")) return icon;
  let tile = true;
  svg = svg.replace(/fill="(?!none)[^"]*"/g, () => {
    const fill = tile ? "#1C1B1F" : "#FF2E7E";
    tile = false;
    return `fill="${fill}"`;
  });
  try { return SVG_ICON + btoa(svg); } catch { return icon; }
}

export function AccountChip({ address, walletIcon }: { address: string; walletIcon?: string }) {
  const [copied, copy] = useCopy(address);
  return <div className="account-chip">
    <button type="button" className="account-chip-button" aria-label={`Owner ${address}`} onClick={copy}>
      {walletIcon ? <img src={tintWalletIcon(walletIcon)} alt="" width={28} height={28} /> : <Icon name="wallet" size={16} />}
    </button>
    <span className={`account-copied${copied ? " is-visible" : ""}`} role="status" aria-live="polite">{copied ? "Copied!" : ""}</span>
  </div>;
}

/** Counts smoothly from the previous value to the new one; screen readers get the final number straight away. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(value); return; }
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - began) / 600);
      setShown(Math.round(start + (value - start) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <><span aria-hidden="true">{shown.toLocaleString("en-US")}</span><span className="sr-only">{value.toLocaleString("en-US")}</span></>;
}

function KeyRow({ label, value, note }: { label: string; value: string; note?: string }) {
  const [copied, copy] = useCopy(value);
  return <div className="key-row">
    <span className="label">{label}{note && <small> · {note}</small>}</span>
    <code title={value} aria-label={value}>{shorten(value)}</code>
    <button className="icon-button" type="button" onClick={copy} aria-label={copied ? `${label} address copied` : `Copy ${label} address`} title={copied ? "Copied" : "Copy"}><Icon name={copied ? "check" : "copy"} size={16} /></button>
  </div>;
}

const alwaysCurrent = () => true;
export function Dashboard({ connection, toolbar, isCurrent = alwaysCurrent, onBusyChange, siteNotice, walletIcon }: {
  connection: DashboardConnection; toolbar: ReactNode; isCurrent?(): boolean; onBusyChange?(busy: boolean): void;
  siteNotice?: ReactNode; walletIcon?: string;
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
  const [ready, setReady] = useState(environment === "mock" || !connection.initialVault);
  const refreshing = useRef(false);
  const currentState = useRef<VaultState | null>(null);
  const polling = useRef<ReturnType<typeof startDashboardPolling> | null>(null);
  const [activityReady, setActivityReady] = useState(false);
  const [stage, setStage] = useState("");
  const [reloading, setReloading] = useState(false);
  const [page, go] = usePage();
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

  const fund = () => run("Fund vault", async () => {
    track(await connection.fund(address.current!, reportProgress), { label: "Fund vault", amount: "1,000 testUSDC" });
    return "Added 1,000 testUSDC to your vault.";
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
    return "Your demo vault is ready with 1,000 testUSDC.";
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

  // Mock mode runs the cases in-process; label the swap so the feed and analytics can read it.
  const runScenario = connection.scenario ? async (kind: Scenario) => {
    const steps = await connection.scenario!(kind, address.current!);
    const result = steps.find((step) => step.type === "result")?.result;
    const request = steps.find((step) => step.type === "request");
    if (result?.signature && request) details.current.set(result.signature, { label: "Agent swap", amount: `${request.amountUsdc} testUSDC` });
    return steps;
  } : undefined;

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
  // A revoked or expired vault is finished: nothing is "next" except starting over.
  const finished = !!vault && (vault.revoked || status === "Expired");
  const hasFunded = !!vault && (hasInput || vault.spentRaw > 0n || vault.outputBalanceRaw > 0n ||
    activity.some((item) => item.ok && details.current.get(item.signature)?.label === "Fund vault"));
  // Oldest → newest for the chart; activity arrives newest first.
  const requestAmount = (item: Activity) => Number((details.current.get(item.signature)?.amount ?? "0").replace(/[^0-9.]/g, "")) || 0;
  const bars: TradeBar[] = swaps.slice(0, 16).reverse().map((item) => ({
    amount: requestAmount(item), id: item.signature, ok: item.ok, error: item.error, time: timeLabel(item.blockTime),
  }));
  const protectedUsdc = swaps.filter((item) => !item.ok).reduce((sum, item) => sum + requestAmount(item), 0);
  const capUi = vault ? Number(rawAmountToUi(vault.maxTradeRaw, 6)) : 50;
  const reasons = [
    { label: "Over the per-trade cap", count: swaps.filter((item) => !item.ok && item.error === "CapExceeded").length },
    { label: "Over the total budget", count: swaps.filter((item) => !item.ok && item.error === "BudgetExceeded").length },
    { label: "Wrong destination", count: swaps.filter((item) => !item.ok && item.error === "AccountMismatch").length },
    { label: "AI stopped or window closed", count: swaps.filter((item) => !item.ok && ["Revoked", "Expired", "Unauthorized"].includes(item.error ?? "")).length },
  ];
  const fundingText = needsFaucet(walletBalance, !!connection.faucet)
    ? "First grab free test USDC, then move it into the vault."
    : "Move 1,000 test USDC from your wallet into the vault.";

  // What the owner must do before the AI can trade; null once it can.
  const blocker = !vault ? "create" : finished ? "closed" : !hasInput ? "fund" : null;
  const link = (id: PageId, label: ReactNode) => <a className="text-link" href={`#/${id}`}>{label}<Icon name="arrow" size={13} /></a>;

  const activityRows = (rows: Activity[]) => <table className="table">
    <thead><tr><th>Event</th><th className="hide-sm">Amount</th><th>Status</th><th className="num">Time</th><th aria-label="Explorer link" /></tr></thead>
    <tbody>{rows.map((item) => {
      const detail = details.current.get(item.signature);
      const entry = feedEntry(item, detail, vault);
      return <tr key={item.signature}>
        <td><div className="event"><span className={`event-icon ${entry.tone}`} aria-hidden="true"><Icon name={entry.icon} size={14} /></span>
          <div><strong>{entry.title}</strong>{entry.sub && <span>{entry.sub}</span>}</div></div></td>
        <td className="hide-sm num-cell">{detail ? groupThousands(detail.amount) : "0"}</td>
        <td><span className={`badge ${item.ok ? "ok" : detail?.label === "Agent swap" ? "bad" : "warn"}`}>{item.ok ? "Succeeded" : detail?.label === "Agent swap" ? "Blocked" : "Failed"}</span></td>
        <td className="num muted"><time>{timeLabel(item.blockTime)}</time></td>
        <td className="link-cell">{environment !== "mock" && <a className="feed-link" title={environment === "localnet" ? "Explorer uses your local chain. Allow local network access if prompted." : "View on Solana Explorer (devnet)"}
          aria-label={`View transaction ${item.signature} on Solana Explorer`} href={explorerTransactionUrl(item.signature, environment)} target="_blank" rel="noopener noreferrer"><Icon name="external" size={13} /></a>}</td>
      </tr>;
    })}</tbody>
  </table>;
  const activityBody = (limit?: number) => vault && !activityReady ? <p className="empty" role="status">Loading…</p>
    : !vault || activity.length === 0 ? <div className="empty"><strong>No activity yet</strong><span>Every trade and every blocked attempt will show up here.</span></div>
    : activityRows(limit ? activity.slice(0, limit) : activity);

  const checklist = blocker && <section className="card setup-card" aria-labelledby="setup-title">
    <div className="card-head"><div>
      <h2 id="setup-title">{blocker === "create" ? "Set up your demo vault" : blocker === "fund" ? (hasFunded ? "Top up your vault" : "Add test money") : "This vault is closed"}</h2>
      <p className="card-sub">{blocker === "create" ? "A vault is a safe box for your AI’s trading money. One click opens it with safe limits and adds 1,000 test USDC."
        : blocker === "fund" ? "Your vault is open. Give the AI something to trade with."
        : vault!.revoked ? "You stopped the AI, so it can’t trade from this vault anymore." : "The one-hour trading window ended, so the AI can’t trade anymore."}</p>
    </div></div>
    <ol className="checklist">
      <li className={vault ? "done" : "next"}><span className="check-dot" aria-hidden="true">{vault ? <Icon name="check" size={12} /> : 1}</span>Create your vault</li>
      <li className={hasFunded ? "done" : vault && !finished ? "next" : ""}><span className="check-dot" aria-hidden="true">{hasFunded ? <Icon name="check" size={12} /> : 2}</span>Add test money</li>
      <li className={swaps.length ? "done" : ""}><span className="check-dot" aria-hidden="true">{swaps.length ? <Icon name="check" size={12} /> : 3}</span>Try to trick the AI</li>
    </ol>
    {blocker === "create" ? <div className="next-action">
      <ProgressButton className="primary" disabled={locked} busy={busy === "New demo vault"} progress="Setting up…"
        onClick={() => void newDemo()}>Create my vault</ProgressButton>
      {connection.walletMode && <p className="next-hint">Phantom will ask you to approve.</p>}
    </div> : <FundingStep balance={walletBalance} hasFaucet={!!connection.faucet} finished={blocker === "closed"} locked={locked} busy={busy}
      text={fundingText} onFaucet={() => void run("Get testUSDC", connection.faucet!)} onFund={() => void fund()} onNewDemo={() => void newDemo()} />}
  </section>;

  const stats = <section className="stats" aria-label="Vault at a glance">
    <div className="stat">
      <span className="stat-label">Vault balance</span>
      <strong className="stat-value"><span data-testid="input-balance">{vault ? amount(vault.inputBalanceRaw) : "0"}</span><small>testUSDC</small></strong>
      <span className="stat-sub"><span data-testid="output-balance">+{vault ? amount(vault.outputBalanceRaw, 9) : "0"}</span> testSOL bought by the AI</span>
    </div>
    <div className="stat">
      <span className="stat-label">Budget left</span>
      <strong className="stat-value"><span data-testid="remaining-budget">{vault ? amount(remaining) : "100"}</span><small>of {vault ? amount(vault.budgetRaw) : "100"} testUSDC</small></strong>
      <div className={`meter ${vault ? budgetLevel : "neutral"}`} role="img" aria-label={vault ? `${amount(remaining)} of ${amount(vault.budgetRaw)} testUSDC left, ${spentPercent}% spent` : "Full budget"}><span style={{ width: `${vault ? Number(remainingBasisPoints) / 100 : 100}%` }} /></div>
    </div>
    <div className="stat">
      <span className="stat-label">Time left</span>
      <strong className="stat-value"><span data-testid="expiry">{vault ? countdown(vault.expiryUnix, now) : "1 hour"}</span></strong>
      <div className="meter neutral" role="img" aria-label={vault ? `${lifePercent}% of the hour remaining` : "Full hour"}><span style={{ width: `${vault ? lifePercent : 100}%` }} /></div>
    </div>
    <div className="stat">
      <span className="stat-label">Attacks blocked</span>
      <strong className={`stat-value${blocked ? " pink" : ""}`}><CountUp value={blocked} /></strong>
      <span className="stat-sub">{swaps.length ? `${allowedSwaps} of ${swaps.length} requests allowed` : "No requests yet"}</span>
    </div>
  </section>;

  const rulesCard = <section className="card" aria-labelledby="rules-title">
    <div className="card-head"><h2 id="rules-title">Your rules</h2><span className="badge"><Icon name="lock" size={12} />Enforced on-chain</span></div>
    <dl className="rows">
      <div><dt>Per-trade cap</dt><dd>{vault ? amount(vault.maxTradeRaw) : "50"} testUSDC</dd></div>
      <div><dt>Total budget</dt><dd>{vault ? amount(vault.budgetRaw) : "100"} testUSDC</dd></div>
      <div><dt>Spent so far</dt><dd data-testid="spent">{vault ? amount(vault.spentRaw) : "0"} testUSDC</dd></div>
      <div><dt>Trading window</dt><dd>{vault ? (status === "Active" ? `${countdown(vault.expiryUnix, now)} left` : status) : "1 hour from creation"}</dd></div>
      <div><dt>Output goes to</dt><dd>This vault only</dd></div>
    </dl>
    <p className="card-foot">The AI can’t change these rules, even if it’s tricked.</p>
  </section>;

  const content = page === "overview" ? <>
    {checklist}
    {stats}
    {!blocker && swaps.length === 0 && <section className="card callout">
      <span className="callout-icon" aria-hidden="true"><Icon name="robot" size={20} /></span>
      <div><h2>Your AI is ready. Try to trick it.</h2><p className="card-sub">Run a normal trade, then two attacks, and watch Aegis decide.</p></div>
      <button type="button" className="primary" onClick={() => go("agent")}>Run the test cases<Icon name="arrow" size={14} /></button>
    </section>}
    <div className="grid-2">
      <section className="card flush" aria-labelledby="recent-title">
        <div className="card-head"><h2 id="recent-title">Recent activity</h2>{activity.length > 5 && link("activity", "View all")}</div>
        {activityBody(5)}
      </section>
      {rulesCard}
    </div>
  </> : page === "agent" ? <>
    {blocker && <div className="banner"><Icon name="info" size={16} /><span>{blocker === "closed" ? "This vault is closed. Open a new demo vault to run the cases again." : "Set up and fund your vault before running the cases."}</span>{blocker === "closed"
      ? <ProgressButton className="primary small" disabled={locked} busy={busy === "New demo vault"} progress="Setting up…" onClick={() => void newDemo()}>New demo vault</ProgressButton>
      : <button type="button" className="primary small" onClick={() => go("overview")}>Go to setup<Icon name="arrow" size={14} /></button>}</div>}
    <AgentConsole environment={environment} walletMode={connection.walletMode} key={address.current?.toBase58()} vault={vault} finished={finished}
      disabled={!!busy || loading || !!blocker} onBusy={setAgentBusy} onComplete={refreshAfterAgent} runScenario={runScenario} />
  </> : page === "analytics" ? <>
    <section className="stats" aria-label="Request totals">
      <div className="stat kpi"><span className="stat-label">Requests</span><strong className="stat-value"><CountUp value={swaps.length} /></strong></div>
      <div className="stat kpi is-ok"><span className="stat-label">Allowed</span><strong className="stat-value"><CountUp value={allowedSwaps} /></strong></div>
      <div className="stat kpi is-bad"><span className="stat-label">Blocked</span><strong className="stat-value"><CountUp value={blocked} /></strong></div>
      <div className="stat kpi is-pink"><span className="stat-label">Money protected</span><strong className="stat-value"><CountUp value={protectedUsdc} /><small>testUSDC</small></strong></div>
    </section>
    <section className="card" aria-labelledby="chart-title">
      <div className="card-head"><div><h2 id="chart-title">Requests vs. your cap</h2><p className="card-sub">Anything above the dashed line is blocked.</p></div>
        <span className="chart-legend" aria-hidden="true"><span><i />Allowed</span><span><i className="bad" />Blocked</span></span></div>
      {bars.length > 0 ? <TradeBars trades={bars} cap={capUi} unit="testUSDC" />
        : <div className="empty"><strong>No requests yet</strong><span>Run the test cases on the AI agent page.</span>{link("agent", "Open AI agent")}</div>}
    </section>
    <section className="card" aria-labelledby="reasons-title">
      <div className="card-head"><h2 id="reasons-title">Why requests were blocked</h2></div>
      <ul className="reasons">{reasons.map((reason) => <li key={reason.label}>
        <span>{reason.label}</span><b>{reason.count}</b>
        <i aria-hidden="true"><em style={{ width: `${blocked ? (reason.count / blocked) * 100 : 0}%` }} /></i>
      </li>)}</ul>
    </section>
  </> : page === "activity" ? <section className="card flush" aria-labelledby="activity-title">
    <div className="card-head"><h2 id="activity-title">All activity</h2>{activity.length > 0 && <span className="muted small">{activity.length} {activity.length === 1 ? "event" : "events"}</span>}</div>
    {activityBody()}
  </section> : <>
    {rulesCard}
    <section className="card" aria-labelledby="control-title">
      <div className="card-head"><h2 id="control-title">Controls</h2></div>
      {vault ? <div className="settings">
        <div className="setting"><div><strong>Stop the AI</strong><p>{vault.revoked ? "Already stopped. The AI can’t trade from this vault." : "Instantly cut off the AI’s permission to trade."}</p></div>
          <ProgressButton className="danger" disabled={vault.revoked || locked} busy={busy === "Revoke agent"} progress="Revoking…" onClick={() => void revoke()}>Revoke agent</ProgressButton></div>
        <div className="setting"><div><strong>Withdraw everything</strong><p>Send all testUSDC and testSOL in the vault back to your wallet.</p></div>
          <ProgressButton disabled={!hasBalance || locked} busy={busy === "Withdraw all"} progress="Withdrawing…" onClick={() => void withdraw()}>Withdraw all</ProgressButton></div>
        {!finished && <div className="setting"><div><strong>Start over</strong><p>Open a fresh vault with 1,000 test USDC.</p></div>
          <ProgressButton disabled={locked} busy={busy === "New demo vault"} progress="Setting up…" onClick={() => void newDemo()}>New demo vault</ProgressButton></div>}
      </div> : <p className="empty">Create your vault on the Overview page first.</p>}
    </section>
    <section className="card" aria-labelledby="keys-title">
      <div className="card-head"><h2 id="keys-title">Addresses</h2></div>
      <div className="keys">
        <KeyRow label="Owner" value={owner.toBase58()} />
        <KeyRow label="Agent" value={agent.toBase58()} note={vault?.revoked ? "revoked" : undefined} />
        {vault && <KeyRow label="Vault" value={vault.address.toBase58()} />}
      </div>
    </section>
  </>;

  const toasts = <ToastStack>
    {busy ? <Toast tone="busy" message={`${busy} · ${stage}`} />
      : notice && (notice.ok
        ? <Toast tone="success" message={notice.text} />
        : <Toast tone="error" message={notice.text} onDismiss={() => setNotice(null)} />)}
  </ToastStack>;
  const account = toolbar || <AccountChip address={owner.toBase58()} walletIcon={walletIcon} />;

  // The connect screen's loader carries on (without restarting) until the first vault read lands.
  if (!ready) return <Frame actions={account} links={pageLinks(page)}>{toasts}<main className="db-main--center">{siteNotice}<LoadingDashboard resume /></main></Frame>;

  return <Frame actions={account} links={pageLinks(page)}>
    {toasts}
    <main className="content" key={page}>
      <h1 className="sr-only">Your Aegis vault</h1>
      {siteNotice}
      {connection.getWalletSolBalance && <DevnetSolHint readBalance={connection.getWalletSolBalance} />}
      {content}
    </main>
  </Frame>;
}
