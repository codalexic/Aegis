import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { PublicKey, type Signer } from "@solana/web3.js";
import { createClient, rawAmountToUi, uiAmountToRaw, type Activity, type TxResult, type VaultState } from "@aegis/sdk";

// Mock identities contain only public addresses. The SDK never signs in mock mode.
function mockIdentity(byte: number): Signer {
  return {
    publicKey: new PublicKey(new Uint8Array(32).fill(byte)),
    get secretKey(): Uint8Array { throw new Error("Mock identities cannot sign transactions."); },
  };
}
const owner = mockIdentity(3);
const agent = mockIdentity(4);
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

type ActionDetail = { label: string; amount: string };

export function App() {
  const environment = import.meta.env.AEGIS_ENV as "mock" | "localnet";
  return <>
    <header className="site-header">
      <div className="header-inner">
        <a className="brand" href="/" aria-label="Aegis home"><img src="/favicon.svg" alt="" />Aegis</a>
        <span className="header-caption">Agent vault</span>
        <div className="environment"><span className="environment-dot" />{environment}</div>
        {environment === "localnet" && <span className="local-key-label">test key · localnet only</span>}
      </div>
    </header>
    {environment === "mock" ? <MockDashboard /> : <main>
      <h1>Localnet is not connected</h1>
      <p className="muted">Start with AEGIS_ENV=mock to explore the vault demo.</p>
    </main>}
  </>;
}

function MockDashboard() {
  const [client] = useState(() => createClient("mock"));
  const address = useRef<PublicKey | null>(null);
  const details = useRef(new Map<string, ActionDetail>());
  const running = useRef(false);
  const [vault, setVault] = useState<VaultState | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [now, setNow] = useState(nowUnix);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [tradeAmount, setTradeAmount] = useState("20");

  const refresh = useCallback(async () => {
    setNow(nowUnix());
    if (!address.current) return;
    const [state, history] = await Promise.all([client.getVault(address.current), client.listActivity(address.current)]);
    setVault(state);
    setActivity(history);
  }, [client]);

  useEffect(() => {
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
    const result = track(await client.createVault(owner, {
      vaultId: 0n, agent: agent.publicKey, maxTradeRaw: 50_000_000n,
      budgetRaw: 100_000_000n, expiryUnix: nowUnix() + 3_600n,
    }), { label: "Create vault", amount: "—" });
    if (!result.vault) throw new Error("No vault address was returned.");
    address.current = result.vault;
    return "Vault created. Fund it to try an agent trade.";
  });

  const fund = () => run("Fund vault", async () => {
    track(await client.fundVault(owner, address.current!, 1_000_000_000n), { label: "Fund vault", amount: "1,000 testUSDC" });
    return "Added 1,000 testUSDC to your mock vault.";
  });

  const revoke = () => run("Revoke agent", async () => {
    track(await client.revoke(owner, address.current!), { label: "Revoke agent", amount: "—" });
    return "Agent revoked. You can still withdraw your funds.";
  });

  const withdraw = () => run("Withdraw all", async () => {
    const state = await client.getVault(address.current!);
    for (const [mint, balance, decimals, symbol] of [
      [state.inputMint, state.inputBalanceRaw, 6, "testUSDC"],
      [state.outputMint, state.outputBalanceRaw, 9, "testSOL"],
    ] as const) {
      if (balance > 0n) track(await client.withdraw(owner, state.address, mint, balance), {
        label: "Withdraw", amount: `${amount(balance, decimals)} ${symbol}`,
      });
    }
    return "All available funds withdrawn from the mock vault.";
  });

  function trade(event: FormEvent) {
    event.preventDefault();
    void run("Agent trade", async () => {
      let raw: bigint;
      try { raw = uiAmountToRaw(tradeAmount, 6); }
      catch { throw new Error("Enter a valid testUSDC amount with up to 6 decimal places."); }
      track(await client.swap(agent, address.current!, raw), { label: "Agent swap", amount: `${amount(raw)} testUSDC` });
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

    <div className="mock-note"><span className="note-icon" aria-hidden="true">i</span><span><strong>Mock environment</strong> · Simulated funds and transactions. Refreshing the page starts a new session.</span></div>
    {busy && <p className="notice" role="status">{busy}…</p>}
    {notice && <p className={`notice ${notice.ok ? "success" : "error"}`} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}

    <section className="vault-card" aria-labelledby="vault-title">
      <div className="card-heading">
        <div><p className="eyebrow">YOUR VAULT</p><h2 id="vault-title">Trading vault</h2></div>
        <span className={`status ${status.toLowerCase().replace(" ", "-")}`} data-testid="vault-status"><span className="small-dot" />{status}</span>
      </div>
      {!vault && <div className="empty-vault"><strong>Start with a vault. Keep the limits fixed.</strong><p>Create your mock vault with a 50 testUSDC trade cap, a 100 testUSDC budget, and a one-hour expiry.</p></div>}
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
        <div><span className="field-label">Owner</span><code>{owner.publicKey.toBase58()}</code></div>
        <div><span className="field-label">Agent <span className="identity-note">{vault?.revoked ? "· revoked" : "· trading only"}</span></span><code>{agent.publicKey.toBase58()}</code></div>
      </div>
      {vault && <p className="vault-address">Vault <code>{vault.address.toBase58()}</code></p>}
      <div className="actions">
        <button className="primary" disabled={!!vault || !!busy} onClick={() => void create()}>Create vault</button>
        <button disabled={!vault || !!busy} onClick={() => void fund()}>Fund 1,000</button>
        <button className="danger" disabled={!vault || vault.revoked || !!busy} onClick={() => void revoke()}>Revoke agent</button>
        <button disabled={!hasBalance || !!busy} onClick={() => void withdraw()}>Withdraw all <span aria-hidden="true">↗</span></button>
      </div>
    </section>

    <section className="trade-card" aria-labelledby="trade-title">
      <div><h2 id="trade-title">Try an agent trade</h2><p className="muted">20 testUSDC fits the policy. Try 60 to see the cap reject a trade.</p></div>
      <form onSubmit={trade}>
        <label htmlFor="trade-amount">Amount <span>testUSDC</span></label>
        <div className="trade-controls"><input id="trade-amount" inputMode="decimal" value={tradeAmount} onChange={(event) => setTradeAmount(event.target.value)} disabled={!vault || !!busy} autoComplete="off" /><button className="primary" disabled={!vault || !!busy} type="submit">Swap</button></div>
      </form>
    </section>

    <section className="activity-card" aria-labelledby="activity-title">
      <div className="card-heading"><div><p className="eyebrow">HISTORY</p><h2 id="activity-title">Vault activity</h2></div><span className="activity-count">{activity.length} {activity.length === 1 ? "event" : "events"}</span></div>
      {activity.length === 0 ? <div className="empty-activity"><span aria-hidden="true">↔</span><strong>No activity yet</strong><p>Create your vault to begin. Actions and rejected trades will appear here.</p></div> : <div className="table-scroll"><table>
        <thead><tr><th>Time</th><th>Action</th><th>Amount</th><th>Result</th></tr></thead>
        <tbody>{activity.map((item) => <tr key={item.signature}>
          <td><time>{timeLabel(item.blockTime)}</time></td>
          <td><span className="action-name">{details.current.get(item.signature)?.label ?? "Transaction"}</span><code className="signature">{item.signature}</code></td>
          <td className="activity-amount">{details.current.get(item.signature)?.amount ?? "—"}</td>
          <td><span className={`result ${item.ok ? "ok" : "blocked"}`}><span aria-hidden="true">{item.ok ? "✓" : "✗"}</span> {item.ok ? "Success" : item.error ?? "Failed"}</span></td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    <footer><span>Aegis · Bounded autonomy</span><span>Mock session · Test tokens only</span></footer>
  </main>;
}
