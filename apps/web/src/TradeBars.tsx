// Y domain is fixed at 0 -> cap x 2 so the dashed cap line always sits at 50% of the plot; a request taller
// than that is drawn full height and cut with a two-stroke "break" mark (the ≈ axis-break convention) plus a value label.
import type { JSX } from "react";

/** One agent swap request: how much it asked for and whether the program let it through. */
export type TradeBar = { amount: number; ok: boolean; error?: string; time?: string };

// Fixed geometry (viewBox units). 16 slots of 15px; a 12px column centred in each slot
// leaves >= 2px of surface between neighbours. Plot spans y=6..60; y=60..72 is air only.
const W = 240, H = 72, TOP = 6, BASE = 60, SLOTS = 16, SLOT = W / SLOTS, COL = 12, PLOT = BASE - TOP;
const DOMAIN_X = 2; // domain = cap * DOMAIN_X; the cap line lands at 1/DOMAIN_X (half) of the plot height

/** Path for a column with both top corners rounded by r and a square bottom at y+h. */
export function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h / 2, w / 2); // short bars cannot carry a full 4px radius
  return `M${x},${y + rr} A${rr},${rr} 0 0 1 ${x + rr},${y} H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr} V${y + h} H${x} Z`;
}

/** Trade requests vs the per-trade cap: one column per request, a hairline at the cap. */
export function TradeBars({ trades, cap, unit, className }: {
  trades: TradeBar[];      // oldest -> newest, already limited to the last ~16 by the caller
  cap: number;             // per-trade cap in the same unit
  unit: string;            // e.g. "testUSDC"
  className?: string;
}): JSX.Element {
  const shown = trades.slice(-SLOTS);              // defensive: never more than 16 slots
  const offset = SLOTS - shown.length;             // right-align so the newest is the last slot
  const blocked = shown.filter((t) => !t.ok).length;

  // Linear 0 -> cap*2. Anything above the domain is truncated: full height + break mark + label.
  const domain = cap * DOMAIN_X || 1;
  const over = (v: number) => v > domain;
  const heightFor = (v: number) => (v <= 0 ? 0 : over(v) ? PLOT : Math.max(4, (v / domain) * PLOT));
  const truncated = shown.filter((t) => over(t.amount)).length;

  const capY = BASE - (cap / domain) * PLOT;       // always 50% up the plot, so the label fits above
  const label = shown.length === 0
    ? "No trade requests yet"
    : `${shown.length.toLocaleString()} trade requests; ${blocked.toLocaleString()} blocked above the ${cap.toLocaleString()} ${unit} cap`
      + (truncated > 0 ? `; scale capped at ${domain.toLocaleString()} ${unit}; taller requests are marked` : "");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} className={className}>
      {/* Empty slots: faint 3px track stubs so the strip reads as a timeline with room */}
      {Array.from({ length: offset }, (_, i) => (
        <rect key={`t${i}`} x={i * SLOT + (SLOT - COL) / 2} y={BASE - 3} width={COL} height={3} fill="var(--chart-track, #ececf0)" />
      ))}

      {/* Baseline, drawn before the columns so they sit on it */}
      <line x1={0} x2={W} y1={BASE} y2={BASE} stroke="var(--chart-line, #c4c6d0)" strokeWidth={1} />

      {/* One column per request; the hit rect spans the full slot so the tooltip is easy to reach */}
      {shown.map((t, i) => {
        const slot = offset + i, x = slot * SLOT + (SLOT - COL) / 2;
        const h = heightFor(t.amount), cut = over(t.amount);
        // Label a truncated bar only if the next one is not also truncated (rightmost of a run wins).
        const labelled = cut && !(i + 1 < shown.length && over(shown[i + 1].amount));
        const tip = `${t.amount.toLocaleString()} ${unit} · ${t.ok ? "allowed" : `blocked (${t.error ?? "rejected"})`}${t.time ? ` · ${t.time}` : ""}`;
        return (
          <g key={`b${slot}`}>
            <title>{tip}</title>
            <rect x={slot * SLOT} y={0} width={SLOT} height={H} fill="transparent" />
            {h > 0 && <path d={roundedTopBar(x, BASE - h, COL, h, 4)} fill={t.ok ? "var(--chart-ink, #141418)" : "var(--chart-bad, #e5484d)"} />}
            {cut && ( // two parallel diagonal gaps in the surface colour, near the top of the bar
              <path d={`M${x - 1},${TOP + 10} L${x + COL + 1},${TOP + 6} M${x - 1},${TOP + 14} L${x + COL + 1},${TOP + 10}`}
                stroke="var(--chart-surface, #f2f2f5)" strokeWidth={2} fill="none" />
            )}
            {labelled && ( // value just left of the bar; the two leftmost slots have no room, so flip right
              <text x={slot < 2 ? x + COL + 3 : x - 3} y={12} textAnchor={slot < 2 ? "start" : "end"} fontSize={11} fontWeight={600} fill="var(--chart-muted, #5b5e6b)">
                {t.amount.toLocaleString()}
              </text>
            )}
          </g>
        );
      })}

      {/* The cap: a dashed threshold line across the plot (distinct from the solid baseline) plus a muted label above its left end */}
      <line x1={0} x2={W} y1={capY} y2={capY} stroke="var(--chart-muted, #5b5e6b)" strokeWidth={1} strokeDasharray="3 3" />
      <text x={2} y={capY - 3} fontSize={11} fontWeight={600} textAnchor="start" fill="var(--chart-muted, #5b5e6b)">
        cap {cap.toLocaleString()}
      </text>
    </svg>
  );
}
