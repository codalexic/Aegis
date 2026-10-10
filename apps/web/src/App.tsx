import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PublicKey } from "@solana/web3.js";
import type { AegisEnvironment, Activity, TxResult, VaultState } from "@aegis/sdk";
import { rawAmountToUi, uiAmountToRaw } from "../../../packages/sdk/src/amounts";
import { connectDashboard, type DashboardConnection } from "./client";
import type { ActionDetail } from "./activity";
import { AgentConsole, rejectionReason } from "./AgentConsole";
import { useWallet } from "./wallet-react";
import { connectWalletDashboard } from "./wallet-client";
import { explorerTransactionUrl } from "../../../packages/sdk/src/explorer";
const nowUnix = () => BigInt(Math.floor(Date.now() / 1000));
const shorten = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;

function amount(raw: bigint, decimals = 6): string {
  const [whole, fraction] = rawAmountToUi(raw, decimals).split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

function countdown(expiry: bigint, now: bigint): string {
  const remaining = expiry > now ? expiry - now : 0n;
  return remaining === 0n ? "Expired" : `${remaining / 60n}m ${(remaining % 60n).toString().padStart(2, "0")}s`;
}

function timeLabel(unix?: bigint): string {
  return unix === undefined ? "—" : new Date(Number(unix * 1000n)).toLocaleTimeString([], { hour12: false });
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
  return <>
    <header className="site-header">
      <div className="header-inner">
        <a className="brand" href="/" aria-label="Aegis home"><img src="/favicon.svg" alt="" />Aegis</a>
        <span className="header-caption">Agent vault</span>
        {walletMode && <button disabled={wallet.connecting || wallet.disconnecting} onClick={() => void (wallet.connected ? wallet.disconnect() : wallet.connect()).catch(() => {})}>{wallet.connected ? "Disconnect wallet" : "Connect wallet"}</button>}
        <div className="environment" title={environment === "devnet" ? "Solana devnet · Test tokens only · Set Phantom to devnet" : environment === "localnet" ? "Real transactions on your local Solana chain. Test tokens only · test key · localnet only" : "Simulated funds and transactions. Refreshing the page starts a new session."}><span className="environment-dot" />{environment}</div>
      </div>
    </header>
    {environment === "devnet" && <aside className="try-it" aria-labelledby="try-it-title">
      <h2 id="try-it-title">How to try it</h2>
      <p><a href="https://phantom.com/download" target="_blank" rel="noreferrer">Install Phantom</a> → Settings → Developer Settings → Testnet Mode → Solana Devnet → Connect wallet → Get 1,000 testUSDC → New demo vault.</p>
      <p className="muted">Get free devnet SOL for wallet fees at <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">Solana Faucet</a>. Approve vault creation and funding in Phantom, then try the agent buttons. Test tokens have no monetary value.</p>
    </aside>}
    {connection ? <Dashboard key={`${environment}:${connection.owner.toBase58()}`} connection={connection} /> : <main><p role={error ? "alert" : "status"}>{error ?? (walletMode && !wallet.connected ? `Connect Phantom on ${environment}. Your wallet needs SOL on this cluster for fees.` : "Connecting to the vault…")}</p></main>}
  </>;
}

function Dashboard({ connection }: { connection: DashboardConnection }) {
  const { client, owner, agent, environment } = connection;
  const address = useRef<PublicKey | null>(connection.initialVault);
  const details = useRef(new Map<string, ActionDetail>());
  const running = useRef(false);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [now, setNow] = useState(nowUnix);
  const [busy, setBusy] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [tradeAmount, setTradeAmount] = useState("20");
  const [ready, setReady] = useState(environment === "mock" || !connection.initialVault);
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    setNow(nowUnix());
    if (!address.current || refreshing.current) return;
    const selected = address.current;
    refreshing.current = true;
    try {
      let state: VaultState;
      try { state = await client.getVault(selected); } catch (error) {
        if (address.current !== selected) return;
        if (error instanceof Error && error.message === "VaultNotFound") { setVault(null); setActivity([]); setReady(true); return; }
        throw error;
      }
      const history = await client.listActivity(selected);
      if (connection.readDetail) await Promise.all(history.filter((item) => !details.current.has(item.signature)).map(async (item) => {
        const detail = await connection.readDetail!(item.signature, state);
        if (detail) details.current.set(item.signature, detail);
      }));
      if (address.current !== selected) return;
      setVault(state);
      setActivity(history);
      setReady(true);
    } finally { refreshing.current = false; }
  }, [client, connection]);

  useEffect(() => {
    void refresh().catch(() => setNotice({ ok: false, text: "Could not refresh vault state. Check the cluster connection." }));
    const timer = window.setInterval(() => {
      void refresh().catch(() => setNotice({ ok: false, text: "Could not refresh vault state." }));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

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
      setNotice({ ok: false, text: error instanceof Error ? error.message : "Action failed." });
    } finally {
      try { await refresh(); } catch { setNotice({ ok: false, text: "Could not refresh vault state." }); }
      running.current = false;
      setBusy(null);
    }
  }

  const create = () => run("Create vault", async () => {
    const result = track(await connection.create(), { label: "Create vault", amount: "—" });
    if (!result.vault) throw new Error("No vault address was returned.");
    address.current = result.vault;
    return "Vault created. Fund it to try an agent trade.";
  });

  const fund = () => run("Fund vault", async () => {
    track(await connection.fund(address.current!), { label: "Fund vault", amount: "1,000 testUSDC" });
    return `Added 1,000 testUSDC to your ${environment} vault.`;
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
    return `New ${environment} vault funded with 1,000 testUSDC. Spent: 0.`;
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
    return `All available funds withdrawn from the ${environment} vault.`;
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

  const remaining = vault ? vault.budgetRaw - vault.spentRaw : 0n;
  const remainingBasisPoints = vault ? remaining * 10_000n / vault.budgetRaw : 0n;
  const budgetLevel = vault && remaining * 100n < vault.budgetRaw * 15n ? "low"
    : vault && remaining * 100n < vault.budgetRaw * 40n ? "warning" : "healthy";
  const status = !vault ? "Not created" : vault.revoked ? "Revoked" : now >= vault.expiryUnix ? "Expired" : "Active";
  const hasBalance = vault && (vault.inputBalanceRaw > 0n || vault.outputBalanceRaw > 0n);

  return <main>
    <div className="page-heading">
      <h1>AI agents can be tricked. Aegis enforces the limits on-chain.</h1>
      {connection.faucet && <button disabled={!!busy || agentBusy} onClick={() => void run("Get testUSDC", connection.faucet!)}>Get 1,000 testUSDC</button>}
      <button className="primary" disabled={!ready || !!busy || agentBusy} onClick={() => void newDemo()}>New demo vault</button>
    </div>

    <div className={`mock-note ${environment !== "mock" ? "localnet-note" : ""}`}><span className="note-icon" aria-hidden="true">i</span>{environment === "mock"
      ? <span><strong>Mock environment</strong> · Simulated funds and transactions. Refreshing the page starts a new session.</span>
      : <span><strong>{environment === "devnet" ? "Devnet" : "Localnet"} environment</strong> · Real transactions on {environment === "devnet" ? "Solana devnet" : "your local Solana chain"}. Test tokens only.</span>}</div>
    <div className="dashboard-notice">
      {busy ? <p className="notice" role="status">{busy}…</p>
        : notice && <p className={`notice ${notice.ok ? "success" : "error"}`} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}
    </div>

    <div className={environment !== "mock" ? "dashboard-panels" : undefined}>
    <section className={`vault-card ${vault ? "" : "is-empty"}`} aria-labelledby="vault-title">
      <div className="card-heading">
        <h2 id="vault-title">Trading vault</h2>
        <span className={`status ${status.toLowerCase().replace(" ", "-")}`} data-testid="vault-status"><span className="small-dot" />{status}</span>
      </div>
      <p className="vault-empty">No vault yet · Click New demo vault</p>
      <div className="balances">
        <div className="balance"><span className="field-label">Input balance</span><div className="balance-value"><strong data-testid="input-balance">{vault ? amount(vault.inputBalanceRaw) : "—"}</strong><span className="token-mark"><span className="token-dot" aria-hidden="true" />testUSDC</span></div></div>
        <div className="balance"><span className="field-label">Output balance</span><div className="balance-value"><strong data-testid="output-balance">{vault ? amount(vault.outputBalanceRaw, 9) : "—"}</strong><span className="token-mark"><span className="token-dot sol" aria-hidden="true" />testSOL</span></div></div>
      </div>
      <div className="policy-grid">
        <div><span className="field-label">Per-trade cap</span><strong>{vault ? amount(vault.maxTradeRaw) : "50"} <small>testUSDC</small></strong></div>
        <div><span className="field-label">Total budget</span><strong>{vault ? amount(vault.budgetRaw) : "100"} <small>testUSDC</small></strong></div>
        <div><span className="field-label">Spent</span><strong data-testid="spent">{vault ? amount(vault.spentRaw) : "—"} <small>testUSDC</small></strong></div>
        <div><span className="field-label">Expires in</span><strong className="countdown" data-testid="expiry">{vault ? countdown(vault.expiryUnix, now) : "1h on creation"}</strong></div>
      </div>
      <div className={`budget-section ${budgetLevel}`}>
        <span className="budget-label">Remaining budget</span>
        <div className="budget-bar">
          <progress aria-label="Remaining budget" aria-valuetext={vault ? `${amount(remaining)} of ${amount(vault.budgetRaw)} testUSDC remaining` : "No vault"} value={remainingBasisPoints.toString()} max="10000" />
          <span className="budget-number" data-testid="remaining-budget">{vault ? <><strong>{amount(remaining)}</strong><small> / {amount(vault.budgetRaw)} testUSDC</small></> : "Create a vault to activate"}</span>
        </div>
      </div>
      <div className="identities">
        <div><span className="field-label">Owner</span><code title={owner.toBase58()} aria-label={owner.toBase58()}>{shorten(owner.toBase58())}</code></div>
        <div><span className="field-label">Agent <span className="identity-note">{vault?.revoked ? "· revoked" : "· trading only"}</span></span><code title={agent.toBase58()} aria-label={agent.toBase58()}>{shorten(agent.toBase58())}</code></div>
        {vault && <p className="vault-address">Vault <code title={vault.address.toBase58()} aria-label={vault.address.toBase58()}>{shorten(vault.address.toBase58())}</code></p>}
      </div>
      <div className="actions">
        <button className="primary" disabled={!ready || !!vault || !!busy || agentBusy} onClick={() => void create()}>Create vault</button>
        <button disabled={!vault || !!busy || agentBusy} onClick={() => void fund()}>Fund 1,000</button>
        <button className="danger" disabled={!vault || vault.revoked || !!busy || agentBusy} onClick={() => void revoke()}>Revoke agent</button>
        <button disabled={!hasBalance || !!busy || agentBusy} onClick={() => void withdraw()}>Withdraw all</button>
      </div>
    </section>
    {environment !== "mock" && <AgentConsole environment={environment} walletMode={connection.walletMode} key={address.current?.toBase58()} vault={vault} disabled={!!busy} onBusy={setAgentBusy} onComplete={refresh} />}
    </div>

    {environment === "mock" ? <section className="trade-card" aria-labelledby="trade-title">
      <div><h2 id="trade-title">Try an agent trade</h2><p className="muted">20 testUSDC fits the policy. Try 60 to see the cap reject a trade.</p></div>
      <form onSubmit={trade}>
        <label htmlFor="trade-amount">Amount <span>testUSDC</span></label>
        <div className="trade-controls"><input id="trade-amount" inputMode="decimal" value={tradeAmount} onChange={(event) => setTradeAmount(event.target.value)} disabled={!vault || !!busy} autoComplete="off" /><button className="primary" disabled={!vault || !!busy} type="submit">Swap</button></div>
      </form>
    </section> : null}

    <section className="activity-card" aria-labelledby="activity-title">
      <div className="card-heading"><h2 id="activity-title">Vault activity</h2><span className="activity-count">{activity.length} {activity.length === 1 ? "event" : "events"}</span></div>
      {activity.length === 0 ? <div className="empty-activity"><span aria-hidden="true">↔</span><strong>No activity yet</strong><p>Create your vault to begin. Actions and rejected trades will appear here.</p></div> : <div className="table-scroll"><table>
        <thead><tr><th>Time</th><th>Action</th><th>Amount</th><th>Result</th></tr></thead>
        <tbody>{activity.map((item) => <tr key={item.signature}>
          <td><time>{timeLabel(item.blockTime)}</time></td>
          <td><span className="action-name">{details.current.get(item.signature)?.label ?? "Transaction"}</span>
            {environment !== "mock" ? <a className="signature" title={`${item.signature}${environment === "localnet" ? " · Explorer uses your local chain. Allow local network access if prompted." : " · Solana devnet"}`} aria-label={`View transaction ${item.signature} on Solana Explorer`}
              href={explorerTransactionUrl(item.signature, environment)} target="_blank" rel="noopener noreferrer"><code>{shorten(item.signature)}</code></a>
              : <code className="signature">{item.signature}</code>}</td>
          <td className="activity-amount">{details.current.get(item.signature)?.amount ?? "—"}</td>
          <td><span className={`result ${item.ok ? "ok" : "blocked"}`}><span aria-hidden="true">{item.ok ? "✓" : "✗"}</span> {item.ok ? "Success" : item.error ?? "Failed"}</span>
            {!item.ok && vault && <p className="rejection-reason">{rejectionReason(item.error ?? "Failed", vault,
              details.current.get(item.signature)?.amount.replace(/ testUSDC$/, ""))}</p>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    <footer><span>Aegis · Bounded autonomy</span><span>{environment === "mock" ? "Mock session" : environment === "devnet" ? "Devnet chain" : "Localnet chain"} · Test tokens only</span></footer>
  </main>;
}
