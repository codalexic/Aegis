import type { JSX } from "react";

/**
 * Aegis mark — "Vault Arc".
 * A single bold "A" whose apex is a circular arch with legs tangent to it, knocked out of a
 * near-black rounded tile (the UI's primary pill). The crossbar is a lavender bolt sitting
 * behind the legs: the one locking element that keeps the agent inside its limits.
 *
 * Geometry (64-unit grid): stroke 7.4 with round caps, arc r=9.2 centred at (32,22.9),
 * legs splayed 18° from vertical and tangent to the arc, bolt 6.4 thick at y=36.8.
 * The tile is `currentColor`, so the glyph shows whatever sits behind the logo (white on the
 * sidebar card, black when the logo is drawn in white on a dark pill). No mask ids are used,
 * so any number of instances can live on one page.
 */
const TILE = "M16 0h32a16 16 0 0 1 16 16v32a16 16 0 0 1-16 16H16A16 16 0 0 1 0 48V16A16 16 0 0 1 16 0Z";
const GLYPH =
  "M10.03 48.76L19.73 18.91A12.9 12.9 0 0 1 44.27 18.91L53.97 48.76A3.7 3.7 0 0 1 46.93 51.04" +
  "L37.23 21.2A5.5 5.5 0 0 0 26.77 21.2L17.07 51.04A3.7 3.7 0 0 1 10.03 48.76Z";
const BOLT = "M22.74 33.6H41.26L43.34 40H20.66Z";
const ACCENT = "var(--brand-accent, #d2caff)";

export function Logo({ size = 28, withWordmark = false, className }: { size?: number; withWordmark?: boolean; className?: string }): JSX.Element {
  const mark = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={withWordmark ? undefined : className}
      role={withWordmark ? undefined : "img"}
      aria-label={withWordmark ? undefined : "Aegis"}
      aria-hidden={withWordmark ? true : undefined}
      focusable="false"
      style={{ display: "block", flex: "none" }}
    >
      <path d={TILE + GLYPH} fill="currentColor" fillRule="evenodd" />
      <path d={BOLT} fill={ACCENT} />
    </svg>
  );
  if (!withWordmark) return mark;
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.36) }}>
      {mark}
      <span className="logo-wordmark" style={{ fontSize: Math.round(size * 0.64), fontWeight: 750, letterSpacing: "-0.03em", lineHeight: 1 }}>Aegis</span>
    </span>
  );
}
