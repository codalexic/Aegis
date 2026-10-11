// Bars are scaled so the per-trade cap sits at half the plot (domain = cap × 2).
// Larger requests fill the plot and keep their true amount in the value label.
import type { JSX } from "react";

/** One agent swap request: how much it asked for and whether the program let it through. */
export type TradeBar = { amount: number; ok: boolean; error?: string; time?: string };

const W = 360, H = 148, PAD_TOP = 26, BASE = 124, MAX_BARS = 12, GAP = 10, COL = 20, PLOT = BASE - PAD_TOP;
const DOMAIN_X = 2;

export function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h / 2, w / 2);
  return `M${x},${y + rr} A${rr},${rr} 0 0 1 ${x + rr},${y} H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr} V${y + h} H${x} Z`;
}

export function TradeBars({ trades, cap, unit, className }: {
  trades: TradeBar[];
  cap: number;
  unit: string;
  className?: string;
}): JSX.Element {
  const shown = trades.slice(-MAX_BARS);
  const blocked = shown.filter((t) => !t.ok).length;
  const domain = cap * DOMAIN_X || 1;
  const heightFor = (v: number) => {
    if (v <= 0) return 0;
    return Math.max(10, Math.min(PLOT, (v / domain) * PLOT));
  };
  const capY = BASE - (cap / domain) * PLOT;
  const span = shown.length * COL + Math.max(0, shown.length - 1) * GAP;
  const startX = Math.max(16, (W - span) / 2);

  const label = shown.length === 0
    ? "No trade requests yet"
    : `${shown.length.toLocaleString()} trade requests; ${blocked.toLocaleString()} blocked above the ${cap.toLocaleString()} ${unit} per-trade cap`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} className={`trade-bars${className ? ` ${className}` : ""}`}>
      <defs>
        <linearGradient id="tb-ok" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-ink)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--chart-ink)" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="tb-bad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-bad)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--chart-bad)" stopOpacity="0.72" />
        </linearGradient>
      </defs>
      <rect x={0} y={capY} width={W} height={BASE - capY} fill="var(--chart-band, var(--chart-ink))" />
      <line x1={16} x2={W - 16} y1={BASE} y2={BASE} stroke="var(--chart-line)" strokeWidth={1} />
      <line x1={16} x2={W - 16} y1={capY} y2={capY} stroke="var(--chart-muted)" strokeWidth={1} strokeDasharray="3 5" opacity={0.9} />
      <text x={20} y={capY - 6} fontSize={10} fontWeight={650} fill="var(--chart-muted)">cap {cap.toLocaleString()}</text>

      {shown.map((t, i) => {
        const x = startX + i * (COL + GAP);
        const h = heightFor(t.amount);
        const tip = `${t.amount.toLocaleString()} ${unit} · ${t.ok ? "allowed" : `blocked${t.error ? ` (${t.error})` : ""}`}${t.time ? ` · ${t.time}` : ""}`;
        return (
          <g key={`b${i}`} className={`trade-bar trade-bar--${t.ok ? "ok" : "blocked"}`} style={{ ["--bar-delay" as string]: `${i * 50}ms` }}>
            <title>{tip}</title>
            {h > 0 && <>
              <path
                className="trade-bar-shape"
                d={roundedTopBar(x, BASE - h, COL, h, 7)}
                fill={t.ok ? "url(#tb-ok)" : "url(#tb-bad)"}
              />
              <text
                className="trade-bar-value"
                x={x + COL / 2}
                y={BASE - h - 8}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill={t.ok ? "var(--chart-ink)" : "var(--chart-bad)"}
              >
                {t.amount.toLocaleString()}
              </text>
            </>}
          </g>
        );
      })}
    </svg>
  );
}
