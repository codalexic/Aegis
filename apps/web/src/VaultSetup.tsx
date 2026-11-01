import { useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { localDateTime, setupDefaults, validateSetup, type DemoVaultSettings } from "./vault-setup";
import { ProgressButton } from "./Progress";

export function VaultSetup({ owner, agent, busy, onCreate, onCancel }: {
  owner: PublicKey; agent: PublicKey; busy: boolean; onCreate(settings: DemoVaultSettings): void; onCancel(): void;
}) {
  const [fields, setFields] = useState(setupDefaults);
  const [now, setNow] = useState(Date.now);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { errors, settings } = validateSetup(fields, owner, agent, now);
  const wallet = owner.toBase58();
  return <section className="card vault-setup" aria-labelledby="vault-setup-title">
    <h2 id="vault-setup-title" tabIndex={-1} ref={heading}>Set up your vault</h2>
    <form onSubmit={(event) => {
      event.preventDefault();
      const checked = validateSetup(fields, owner, agent);
      setNow(Date.now());
      if (checked.settings && !busy) onCreate(checked.settings);
    }}>
      <fieldset disabled={busy}><legend>Money limits</legend>
        <div className="setup-limits">{([['cap', 'Max per trade'], ['budget', 'Total budget']] as const).map(([field, label]) => <div key={field} className="setup-field">
          <label htmlFor={`setup-${field}`}>{label} (testUSDC)</label>
          <input id={`setup-${field}`} inputMode="decimal" value={fields[field]} aria-invalid={!!errors[field]} aria-describedby={`setup-${field}-error`}
            onChange={(event) => setFields({ ...fields, [field]: event.target.value })} />
          <span className="field-error" id={`setup-${field}-error`}>{errors[field]}</span>
        </div>)}</div>
      </fieldset>
      <fieldset disabled={busy}><legend>Agent can trade until</legend>
        <label className="sr-only" htmlFor="setup-until">Agent can trade until</label>
        <input id="setup-until" type="datetime-local" step="1" value={fields.until} aria-invalid={!!errors.until} aria-describedby="setup-until-error"
          onChange={(event) => setFields({ ...fields, until: event.target.value })} />
        <span className="field-error" id="setup-until-error">{errors.until}</span>
        <div className="setup-buttons">{([['1 hour', 3600], ['1 day', 86400], ['1 week', 604800]] as const).map(([label, seconds]) =>
          <button type="button" key={label} onClick={() => { const now = Date.now(); setNow(now); setFields({ ...fields, until: localDateTime(now + seconds * 1000) }); }}>{label}</button>)}</div>
      </fieldset>
      <fieldset disabled={busy}><legend>Allowed withdrawal addresses</legend>
        <p className="setup-locked">This vault — always allowed (trades always return here)</p>
        <p className="setup-locked">Your wallet ({wallet.slice(0, 4)}…{wallet.slice(-4)}) — always allowed</p>
        {fields.addresses.map((value, index) => <div className="setup-field" key={index}>
          <label htmlFor={`setup-address-${index}`}>Extra address {index + 1}</label>
          <div className="setup-address"><input id={`setup-address-${index}`} value={value} autoComplete="off" spellCheck={false}
            aria-invalid={!!errors.addresses[index]} aria-describedby={`setup-address-${index}-error`}
            onChange={(event) => setFields({ ...fields, addresses: fields.addresses.map((address, i) => i === index ? event.target.value : address) })} />
            <button type="button" aria-label={`Remove address ${index + 1}`} onClick={() => setFields({ ...fields, addresses: fields.addresses.filter((_, i) => i !== index) })}>Remove</button></div>
          <span className="field-error" id={`setup-address-${index}-error`}>{errors.addresses[index]}</span>
        </div>)}
        <button type="button" disabled={fields.addresses.length >= 3} onClick={() => setFields({ ...fields, addresses: [...fields.addresses, ""] })}>+ Add address</button>
        <p className="card-sub">Funds can only be withdrawn to your wallet or these addresses. This list can't be changed after the vault is created.</p>
      </fieldset>
      <div className="setup-buttons">
        <button type="button" disabled={busy} onClick={() => { setNow(Date.now()); setFields(setupDefaults()); }}>Use demo defaults</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <ProgressButton type="submit" className="primary" busy={busy} progress="Creating…" disabled={!settings || busy}>Create vault</ProgressButton>
      </div>
    </form>
  </section>;
}
