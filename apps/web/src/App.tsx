import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PublicKey } from "@solana/web3.js";
import { rawAmountToUi, uiAmountToRaw, type Activity, type TxResult, type VaultState } from "@aegis/sdk";
import { connectDashboard, type DashboardConnection } from "./client";
import type { ActionDetail } from "./activity";
const nowUnix = () => BigInt(Math.floor(Date.now() / 1000));

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
  const environment = import.meta.env.AEGIS_ENV as "mock" | "localnet";
  const [connection, setConnection] = useState<DashboardConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void connectDashboard(environment).then((value) => { if (active) setConnection(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Connection failed."); });
    return () => { active = false; };
  }, [environment]);
  return <>
    <header className="site-header">
      <div className="header-inner">
        <a className="brand" href="/" aria-label="Aegis home"><img src="/favicon.svg" alt="" />Aegis</a>
        <span className="header-caption">Agent vault</span>
        <div className="environment"><span className="environment-dot" />{environment}</div>
        {environment === "localnet" && <span className="local-key-label">test key · localnet only</span>}
      </div>
    </header>
    {connection ? <Dashboard connection={connection} /> : <main><p role={error ? "alert" : "status"}>{error ?? "Connecting to the vault…"}</p></main>}
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
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [tradeAmount, setTradeAmount] = useState("20");
  const [ready, setReady] = useState(environment === "mock");
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    setNow(nowUnix());
    if (!address.current || refreshing.current) return;
    refreshing.current = true;
    try {
      let state: VaultState;
      try { state = await client.getVault(address.current); } catch (error) {
        if (error instanceof Error && error.message === "VaultNotFound") { setVault(null); setActivity([]); setReady(true); return; }
        throw error;
      }
      const history = await client.listActivity(address.current);
      if (connection.readDetail) await Promise.all(history.filter((item) => !details.current.has(item.signature)).map(async (item) => {
        const detail = await connection.readDetail!(item.signature, state);
        if (detail) details.current.set(item.signature, detail);
      }));
      setVault(state);
      setActivity(history);
      setReady(true);
    } finally { refreshing.current = false; }
  }, [client, connection]);

  useEffect(() => {
    void refresh().catch(() => setNotice({ ok: false, text: "Could not refresh vault state. Check that localnet is running." }));
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
    if (running.current) return;
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
  const status = !vault ? "Not created" : vault.revoked ? "Revoked" : now >= vault.expiryUnix ? "Expired" : "Active";
  const hasBalance = vault && (vault.inputBalanceRaw > 0n || vault.outputBalanceRaw > 0n);

  return <main>
    <div className="page-heading">
      <div><p className="eyebrow">CONTROL CENTER</p><h1>Vault overview</h1><p className="muted">An agent can trade. You set the boundaries.</p></div>
      <span className="refresh-note"><span className="small-dot" />Updates every 2 seconds</span>
    </div>

    <div className="mock-note"><span className="note-icon" aria-hidden="true">i</span>{environment === "mock"
      ? <span><strong>Mock environment</strong> · Simulated funds and transactions. Refreshing the page starts a new session.</span>
      : <span><strong>Localnet environment</strong> · Real transactions on your local Solana chain. Test tokens only.</span>}</div>
    {busy && <p className="notice" role="status">{busy}…</p>}
    {notice && <p className={`notice ${notice.ok ? "success" : "error"}`} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}

    <section className="vault-card" aria-labelledby="vault-title">
      <div className="card-heading">
        <div><p className="eyebrow">YOUR VAULT</p><h2 id="vault-title">Trading vault</h2></div>
        <span className={`status ${status.toLowerCase().replace(" ", "-")}`} data-testid="vault-status"><span className="small-dot" />{status}</span>
      </div>
      {!vault && <div className="empty-vault"><strong>Start with a vault. Keep the limits fixed.</strong><p>Create your {environment} vault with a 50 testUSDC trade cap, a 100 testUSDC budget, and a one-hour expiry.</p></div>}
      <div className="balances">
        <div className="balance"><span className="token-icon" aria-hidden="true">U</span><div><span className="field-label">Input balance</span><strong data-testid="input-balance">{vault ? amount(vault.inputBalanceRaw) : "—"}<small>testUSDC</small></strong></div></div>
        <div className="balance"><span className="token-icon sol" aria-hidden="true">S</span><div><span className="field-label">Output balance</span><strong data-testid="output-balance">{vault ? amount(vault.outputBalanceRaw, 9) : "—"}<small>testSOL</small></strong></div></div>
      </div>
      <div className="policy-grid">
        <div><span className="field-label">Per-trade cap</span><strong>{vault ? amount(vault.maxTradeRaw) : "50"} <small>testUSDC</small></strong></div>
        <div><span className="field-label">Total budget</span><strong>{vault ? amount(vault.budgetRaw) : "100"} <small>testUSDC</small></strong></div>
        <div><span className="field-label">Spent</span><strong data-testid="spent">{vault ? amount(vault.spentRaw) : "—"} <small>testUSDC</small></strong></div>
        <div><span className="field-label">Expires in</span><strong className="countdown" data-testid="expiry">{vault ? countdown(vault.expiryUnix, now) : "1 hour after creation"}</strong></div>
      </div>
      <div className="budget-section">
        <div className="budget-label"><span>Remaining budget</span><span data-testid="remaining-budget">{vault ? `${amount(remaining)} / ${amount(vault.budgetRaw)} testUSDC` : "Create a vault to activate"}</span></div>
        <progress aria-label="Remaining budget" value={remainingBasisPoints.toString()} max="10000" />
      </div>
      <div className="identities">
        <div><span className="field-label">Owner</span><code>{owner.toBase58()}</code></div>
        <div><span className="field-label">Agent <span className="identity-note">{vault?.revoked ? "· revoked" : "· trading only"}</span></span><code>{agent.toBase58()}</code></div>
      </div>
      {vault && <p className="vault-address">Vault <code>{vault.address.toBase58()}</code></p>}
      <div className="actions">
        <button className="primary" disabled={!ready || !!vault || !!busy} onClick={() => void create()}>Create vault</button>
        <button disabled={!vault || !!busy} onClick={() => void fund()}>Fund 1,000</button>
        <button className="danger" disabled={!vault || vault.revoked || !!busy} onClick={() => void revoke()}>Revoke agent</button>
        <button disabled={!hasBalance || !!busy} onClick={() => void withdraw()}>Withdraw all <span aria-hidden="true">↗</span></button>
      </div>
    </section>

    {environment === "mock" ? <section className="trade-card" aria-labelledby="trade-title">
      <div><h2 id="trade-title">Try an agent trade</h2><p className="muted">20 testUSDC fits the policy. Try 60 to see the cap reject a trade.</p></div>
      <form onSubmit={trade}>
        <label htmlFor="trade-amount">Amount <span>testUSDC</span></label>
        <div className="trade-controls"><input id="trade-amount" inputMode="decimal" value={tradeAmount} onChange={(event) => setTradeAmount(event.target.value)} disabled={!vault || !!busy} autoComplete="off" /><button className="primary" disabled={!vault || !!busy} type="submit">Swap</button></div>
      </form>
    </section> : <section className="trade-card" aria-labelledby="trade-title">
      <div><h2 id="trade-title">Run the agent</h2><p className="muted">Agent trades and blocked attempts appear below automatically.</p>
        <code className="agent-command">AEGIS_ENV=localnet pnpm agent --mode normal</code>
        <p className="muted">Modes: normal · injected · attacker · scripted</p></div>
    </section>}

    <section className="activity-card" aria-labelledby="activity-title">
      <div className="card-heading"><div><p className="eyebrow">HISTORY</p><h2 id="activity-title">Vault activity</h2></div><span className="activity-count">{activity.length} {activity.length === 1 ? "event" : "events"}</span></div>
      {activity.length === 0 ? <div className="empty-activity"><span aria-hidden="true">↔</span><strong>No activity yet</strong><p>Create your vault to begin. Actions and rejected trades will appear here.</p></div> : <div className="table-scroll"><table>
        <thead><tr><th>Time</th><th>Action</th><th>Amount</th><th>Result</th></tr></thead>
        <tbody>{activity.map((item) => <tr key={item.signature}>
          <td><time>{timeLabel(item.blockTime)}</time></td>
          <td><span className="action-name">{details.current.get(item.signature)?.label ?? "Transaction"}</span><code className="signature" title={item.signature}>{item.signature}</code></td>
          <td className="activity-amount">{details.current.get(item.signature)?.amount ?? "—"}</td>
          <td><span className={`result ${item.ok ? "ok" : "blocked"}`}><span aria-hidden="true">{item.ok ? "✓" : "✗"}</span> {item.ok ? "Success" : item.error ?? "Failed"}</span></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    <footer><span>Aegis · Bounded autonomy</span><span>{environment === "mock" ? "Mock session" : "Localnet chain"} · Test tokens only</span></footer>
  </main>;
}
