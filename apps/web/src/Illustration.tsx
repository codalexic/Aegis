import type { JSX } from "react";

/**
 * Decorative line-art scene for the bottom of the sidebar: a small robot sitting
 * beside the Aegis vault, one hand resting on it, the other on a shield with a check mark.
 * Strokes follow the parent's `color`; retheme with `--illus-accent` and `--illus-bg`.
 */
export function SidebarIllustration({ className }: { className?: string }): JSX.Element {
  const accent = "var(--illus-accent, #c9c4f7)";
  return (
    <svg
      className={className}
      viewBox="0 0 220 160"
      width="100%"
      height="auto"
      role="img"
      aria-label="A friendly robot sitting beside a locked vault, holding a shield with a check mark"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g transform="translate(0 -10)">
        {/* ground shadow and ground line */}
        <ellipse cx={116} cy={141} rx={80} ry={4} fill="var(--illus-bg, #f3f3f6)" stroke="none" />
        <line x1={36} y1={140} x2={190} y2={140} />

        {/* vault: chunky body, door panel, dial, handle, two feet */}
        <rect x={116} y={56} width={72} height={80} rx={12} />
        <rect x={126} y={66} width={52} height={60} rx={8} />
        <circle cx={152} cy={96} r={10} />
        <circle cx={152} cy={96} r={3} />
        <path d="M170 88v16" />
        <rect x={124} y={136} width={12} height={4} rx={2} />
        <rect x={168} y={136} width={12} height={4} rx={2} />

        {/* robot: antenna, head, face, body, legs, arms */}
        <circle cx={80} cy={69} r={3} />
        <path d="M80 72v6" />
        <rect x={64} y={78} width={32} height={24} rx={9} />
        <circle cx={73} cy={88} r={2.2} fill="currentColor" />
        <circle cx={87} cy={88} r={2.2} fill="currentColor" />
        <path d="M75 95q5 4 10 0" />
        <circle cx={90} cy={92} r={2} fill={accent} stroke="none" />
        <circle cx={70} cy={92} r={2} fill={accent} stroke="none" />
        <path d="M80 102v4" />
        <rect x={66} y={106} width={28} height={24} rx={8} />
        <circle cx={80} cy={118} r={4} fill={accent} />
        <rect x={69} y={130} width={8} height={10} rx={4} />
        <rect x={83} y={130} width={8} height={10} rx={4} />
        <path d="M94 114Q104 106 115 112" />
        <path d="M66 112Q60 106 53 107" />

        {/* shield with check mark */}
        <path d="M44 104l14 5v12q0 12-14 19-14-7-14-19v-12z" fill="var(--good-bg, #e3f6ec)" />
        <path d="M37 121l5 5 9-10" stroke="var(--good, #1f9d61)" strokeWidth={2.5} />

        {/* four-point sparkles, matching the sparkle icon in icons.tsx */}
        <path d="M104 62c.3 2.6 1.9 4.3 4.6 4.7-2.7.4-4.3 2.1-4.6 4.7-.3-2.6-1.9-4.3-4.6-4.7 2.7-.4 4.3-2.1 4.6-4.7Z" fill="currentColor" stroke="none" />
        <path d="M200 56c.3 2.6 1.9 4.3 4.6 4.7-2.7.4-4.3 2.1-4.6 4.7-.3-2.6-1.9-4.3-4.6-4.7 2.7-.4 4.3-2.1 4.6-4.7Z" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}
