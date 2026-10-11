import type { JSX } from "react";

export type IconName =
  | "home" | "vault" | "robot" | "activity" | "settings"
  | "wallet" | "coins" | "shield" | "bolt" | "chart"
  | "check" | "x" | "arrow" | "external" | "info"
  | "clock" | "lock" | "copy" | "alert" | "sparkle";

// Every glyph is drawn on a 24x24 grid for a 1.75 stroke with round caps and joins.
// The only solid parts are ~1-unit dots, so the set still reads as one stroke family.
const glyphs: Record<IconName, JSX.Element> = {
  home: (<>
    <path d="M3 11.25 12 4l9 7.25" />
    <path d="M5.25 10v8.5A1.5 1.5 0 0 0 6.75 20h10.5a1.5 1.5 0 0 0 1.5-1.5V10" />
    <path d="M10 20v-5.5h4V20" />
  </>),
  vault: (<>
    <rect x="3" y="4" width="18" height="15" rx="2.5" />
    <circle cx="12" cy="11.5" r="3.5" />
    <path d="M12 11.5l1.75-1.75M6.5 19v2M17.5 19v2" />
  </>),
  robot: (<>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V5.75" />
    <circle cx="12" cy="4.25" r="1.25" />
    <path d="M9 13h.01M15 13h.01" strokeWidth={2.75} />
    <path d="M9.25 16.5c1.5 1.35 4 1.35 5.5 0" />
  </>),
  activity: <path d="M3 12h3.5l2.75-6.5 3.75 13 2.75-6.5H21" />,
  settings: (<>
    <path d="M10.2 5.2 10.6 2.3A9.75 9.75 0 0 1 13.4 2.3L13.8 5.2A7 7 0 0 1 15.5 5.9L17.9 4.2A9.75 9.75 0 0 1 19.8 6.1L18.1 8.5A7 7 0 0 1 18.8 10.2L21.7 10.6A9.75 9.75 0 0 1 21.7 13.4L18.8 13.8A7 7 0 0 1 18.1 15.5L19.8 17.9A9.75 9.75 0 0 1 17.9 19.8L15.5 18.1A7 7 0 0 1 13.8 18.8L13.4 21.7A9.75 9.75 0 0 1 10.6 21.7L10.2 18.8A7 7 0 0 1 8.5 18.1L6.1 19.8A9.75 9.75 0 0 1 4.2 17.9L5.9 15.5A7 7 0 0 1 5.2 13.8L2.3 13.4A9.75 9.75 0 0 1 2.3 10.6L5.2 10.2A7 7 0 0 1 5.9 8.5L4.2 6.1A9.75 9.75 0 0 1 6.1 4.2L8.5 5.9Z" />
    <circle cx="12" cy="12" r="3" />
  </>),
  wallet: (<>
    <rect x="3" y="7" width="18" height="13" rx="2.5" />
    <path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V7" />
    <path d="M21 12.5h-3.5a1.5 1.5 0 0 0 0 3H21" />
  </>),
  coins: (<>
    <ellipse cx="12" cy="7.5" rx="7" ry="3" />
    <path d="M5 7.5V12a7 3 0 0 0 14 0V7.5" />
    <path d="M5 12v4.5a7 3 0 0 0 14 0V12" />
  </>),
  shield: (<>
    <path d="M12 3 5 5.75v5.5c0 4.6 2.9 8.2 7 9.75 4.1-1.55 7-5.15 7-9.75v-5.5Z" />
    <path d="M9 12.25l2.25 2.25L15.25 10" />
  </>),
  bolt: <path d="M13 2.5 5 13.5h6l-1 8 8-11h-6Z" />,
  chart: (<>
    <rect x="4" y="14" width="4" height="6" rx="1" />
    <rect x="10" y="9" width="4" height="11" rx="1" />
    <rect x="16" y="4" width="4" height="16" rx="1" />
  </>),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  arrow: <path d="M4.5 12h15M13.5 6l6 6-6 6" />,
  external: (<>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 13.5v4a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6h4" />
  </>),
  info: (<>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.9" r="1.05" fill="currentColor" stroke="none" />
  </>),
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.25 2" /></>,
  lock: (<>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    <circle cx="12" cy="15.5" r="1.05" fill="currentColor" stroke="none" />
  </>),
  copy: (<>
    <rect x="9" y="9" width="11.5" height="11.5" rx="2.5" />
    <path d="M9 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4" />
  </>),
  alert: (<>
    <path d="M10.3 4.25 2.75 17.5a2 2 0 0 0 1.75 3h15a2 2 0 0 0 1.75-3L13.7 4.25a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4.25" />
    <circle cx="12" cy="17" r="1.05" fill="currentColor" stroke="none" />
  </>),
  sparkle: <path d="M12 3c.6 4.9 3.7 8.2 9 9-5.3.8-8.4 4.1-9 9-.6-4.9-3.7-8.2-9-9 5.3-.8 8.4-4.1 9-9Z" />,
};

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={size <= 14 ? 2 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {glyphs[name]}
    </svg>
  );
}
