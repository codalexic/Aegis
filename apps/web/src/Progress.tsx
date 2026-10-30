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

/** The Aegis mark draws itself inside a turning ring while the dashboard connection resolves. */
export function LoadingDashboard({ resume = false }: { resume?: boolean }) {
  // `resume` continues the connect screen's loader without replaying the draw-in.
  return <div className={`connecting${resume ? " is-resumed" : ""}`} role="status" aria-live="polite" aria-busy="true" data-testid="connecting-logo">
    <div className="connecting-mark" aria-hidden="true">
      <span className="connecting-glow" />
      <span className="connecting-ring" />
      <svg viewBox="0 0 100 100">
        <rect className="cm-bar" x="14" y="12" width="72" height="12" rx="6" />
        <path className="cm-peak" d="M20 86 L41 50 Q50 35 59 50 L80 86" pathLength={100} />
      </svg>
    </div>
    <p className="connecting-title">Connecting to the vault…</p>
    <p className="connecting-sub">Looking up your vault on Solana. This takes a few seconds.</p>
  </div>;
}
