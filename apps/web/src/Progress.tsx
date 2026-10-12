import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from "react";
import { Logo } from "./Logo";

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

/** Centered Aegis mark + spinner while the dashboard connection resolves. */
export function LoadingDashboard() {
  return <div className="connecting" role="status" aria-live="polite" aria-busy="true" data-testid="connecting-logo">
    <div className="connecting-mark" aria-hidden="true">
      <span className="connecting-glow" />
      <span className="connecting-ring connecting-ring--outer" />
      <span className="connecting-ring connecting-ring--inner" />
      <Logo size={44} />
    </div>
    <p>Connecting to the vault…</p>
  </div>;
}
