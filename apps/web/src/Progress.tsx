import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from "react";

/** Keep the idle button's width while its label and icon change. */
export function ProgressButton({ busy = false, progress, children, style, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; progress: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const width = useRef(0);
  useLayoutEffect(() => {
    // offsetWidth stays in layout pixels even when the large-screen shell is zoomed.
    if (!busy && button.current) width.current = button.current.offsetWidth;
  });
  return <button {...props} ref={button} disabled={props.disabled || busy}
    data-busy={busy || undefined} aria-busy={busy || undefined}
    aria-label={busy ? progress : props["aria-label"]} title={busy ? progress : props.title}
    style={{ ...style, ...(busy && width.current > 0 && { width: width.current, flexShrink: 0 }) }}>
    {busy ? <><span className="progress-spinner" aria-hidden="true" /><span className="progress-label">{progress}</span></> : children}
  </button>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}

export function VaultSkeleton() {
  return <div className="vault-skeleton" data-testid="vault-skeleton">
    {[1, 2, 3].map((row) => <div className="skeleton-row" key={row}>
      <Skeleton className="skeleton-circle" /><div><Skeleton /><Skeleton className="skeleton-short" /></div><Skeleton className="skeleton-button" />
    </div>)}
  </div>;
}

export function LoadingDashboard() {
  return <>
    <p role="status" aria-live="polite">Connecting to the vault…</p>
    <div className="loading-dashboard shell--dark" aria-busy="true" aria-label="Loading vault">
    <div className="tiles">
      {(["lavender", "mist", "mint", "cream"] as const).map((tone) => <div className={`tile tile--${tone}`} key={tone}>
        <Skeleton className="skeleton-short" /><Skeleton className="skeleton-value" /><Skeleton />
      </div>)}
    </div>
    <section className="card vault-card"><h2>Trading vault</h2><VaultSkeleton /></section>
  </div></>;
}
