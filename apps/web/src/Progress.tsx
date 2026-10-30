import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from "react";

/** Never narrower than the idle button while its label and icon change, but free to grow for a longer progress label. */
export function ProgressButton({ busy = false, progress, children, style, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; progress: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const width = useRef(0);
  useLayoutEffect(() => {
    if (!busy && button.current) width.current = button.current.offsetWidth;
  });
  return <button {...props} ref={button} disabled={props.disabled || busy}
    data-busy={busy || undefined} aria-busy={busy || undefined}
    aria-label={busy ? progress : props["aria-label"]} title={busy ? progress : props.title}
    style={{ ...style, ...(busy && width.current > 0 && { minWidth: width.current, flexShrink: 0 }) }}>
    {busy ? <><span className="progress-spinner" aria-hidden="true" /><span className="progress-label">{progress}</span></> : children}
  </button>;
}

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
