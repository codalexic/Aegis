import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PublicKey } from "@solana/web3.js";
import { localDateTime, setupDefaults, UNTIL_MAX_MS, UNTIL_MIN_MS, validateSetup, type DemoVaultSettings } from "./vault-setup";
import { DateTimePicker } from "./DateTimePicker";
import { Icon } from "./icons";
import { ProgressButton } from "./Progress";

const AMOUNT_INPUT = /^\d*\.?\d{0,6}$/;

export function VaultSetup({ owner, agent, busy, onCreate, onCancel }: {
  owner: PublicKey; agent: PublicKey; busy: boolean; onCreate(settings: DemoVaultSettings): void; onCancel(): void;
}) {
  const [fields, setFields] = useState(setupDefaults);
  const [now, setNow] = useState(Date.now);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null, root = document.documentElement, overflow = root.style.overflow;
    heading.current?.focus();
    root.style.overflow = "hidden";
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(timer); root.style.overflow = overflow; opener?.focus(); };
  }, []);
  const { errors, settings } = validateSetup(fields, owner, agent, now);
  const cancel = () => { if (!busy) onCancel(); };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
    if (event.key !== "Tab") return;
    const items = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"])');
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || active === heading.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <section className="card vault-setup" role="dialog" aria-modal="true" aria-labelledby="vault-setup-title" onKeyDown={onKeyDown}>
      <header className="modal-head">
        <h2 id="vault-setup-title" tabIndex={-1} ref={heading}>Set up your vault</h2>
        <button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={cancel}><Icon name="x" size={16} /></button>
      </header>
      <form onSubmit={(event) => {
        event.preventDefault();
        const checked = validateSetup(fields, owner, agent);
        setNow(Date.now());
        if (checked.settings && !busy) onCreate(checked.settings);
      }}>
        <div className="modal-body"><fieldset disabled={busy}>
          <div className="setup-limits">{([['cap', 'Max per trade'], ['budget', 'Total budget']] as const).map(([field, label]) => <div key={field} className="setup-field">
            <label htmlFor={`setup-${field}`}>{label}</label>
            <div className="setup-amount">
              <input id={`setup-${field}`} inputMode="decimal" value={fields[field]} aria-invalid={!!errors[field]} aria-describedby={`setup-${field}-error`}
                onChange={(event) => { if (AMOUNT_INPUT.test(event.target.value)) setFields({ ...fields, [field]: event.target.value }); }} />
              <span aria-hidden="true">testUSDC</span>
            </div>
            <span className="field-error" id={`setup-${field}-error`}>{errors[field]}</span>
          </div>)}</div>
          <div className="setup-field">
            <label htmlFor="setup-until-button">Agent can trade until</label>
            <DateTimePicker id="setup-until" value={fields.until} min={now + UNTIL_MIN_MS} max={now + UNTIL_MAX_MS} invalid={!!errors.until} describedBy="setup-until-error"
              onChange={(until) => setFields({ ...fields, until })} />
            <div className="setup-presets">{([['1 hour', 3600], ['6 hours', 21600], ['12 hours', 43200], ['1 day', 86400], ['1 week', 604800]] as const).map(([label, seconds]) =>
              <button type="button" className="small" key={label} onClick={() => { const now = Date.now(); setNow(now); setFields({ ...fields, until: localDateTime(now + seconds * 1000) }); }}>{label}</button>)}</div>
            <span className="field-error" id="setup-until-error">{errors.until}</span>
          </div>
          <div className="setup-field">
            <div className="setup-addresses-head">
              <span className="setup-label">Extra withdrawal addresses</span>
              <button type="button" className="small" disabled={fields.addresses.length >= 3} onClick={() => setFields({ ...fields, addresses: [...fields.addresses, ""] })}>+ Add address</button>
            </div>
            <p className="setup-hint">Optional. Your wallet is always allowed. This list can't be changed later.</p>
            {fields.addresses.map((value, index) => { const error = checked.has(index) ? errors.addresses[index] : ""; return <div className="setup-field" key={index}>
              <label className="sr-only" htmlFor={`setup-address-${index}`}>Extra address {index + 1}</label>
              <div className="setup-address"><input id={`setup-address-${index}`} value={value} placeholder="Solana address" autoComplete="off" spellCheck={false} autoFocus
                aria-invalid={!!error} aria-describedby={`setup-address-${index}-error`} onBlur={() => setChecked(new Set(checked).add(index))}
                onChange={(event) => setFields({ ...fields, addresses: fields.addresses.map((address, i) => i === index ? event.target.value : address) })} />
                <button type="button" className="icon-button" aria-label={`Remove address ${index + 1}`} onClick={() => {
                  setFields({ ...fields, addresses: fields.addresses.filter((_, i) => i !== index) });
                  setChecked(new Set([...checked].filter((i) => i !== index).map((i) => i > index ? i - 1 : i)));
                }}><Icon name="x" size={16} /></button></div>
              <span className="field-error" id={`setup-address-${index}-error`}>{error}</span>
            </div>; })}
          </div>
        </fieldset></div>
        <footer className="modal-foot">
          <button type="button" className="setup-defaults" disabled={busy} onClick={() => { setNow(Date.now()); setFields(setupDefaults()); setChecked(new Set()); }}>Use demo defaults</button>
          <ProgressButton type="submit" className="primary" busy={busy} progress="Creating…" disabled={!settings || busy}>Create vault</ProgressButton>
        </footer>
      </form>
    </section>
  </div>;
}
