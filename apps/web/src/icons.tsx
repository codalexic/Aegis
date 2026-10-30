import type { JSX } from "react";

export type IconName =
  | "vault" | "robot" | "activity" | "wallet" | "coins" | "shield"
  | "check" | "x" | "arrow" | "external" | "info" | "lock" | "copy" | "alert"
  | "swap" | "news" | "redirect";

// Every glyph is drawn on a 24x24 grid for a 1.75 stroke with round caps and joins.
// The only solid parts are ~1-unit dots, so the set still reads as one stroke family.
const glyphs: Record<IconName, JSX.Element> = {
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
  wallet: (<>
    <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 20H6A2.5 2.5 0 0 1 3.5 17.5Z" />
    <path d="M20.5 12.5H16a2 2 0 0 0 0 4h4.5" />
    <circle cx="16" cy="14.5" r="1" fill="currentColor" stroke="none" />
  </>),
  coins: (<>
    <circle cx="9.5" cy="14" r="5.5" />
    <path d="M14.2 16.8A5.5 5.5 0 1 0 14.2 7.2" />
    <path d="M7.5 14h4M9.5 12v4" />
  </>),
  shield: (<>
    <path d="M12 3.25 4.75 6v5.4c0 4.85 3.05 8.55 7.25 10.1 4.2-1.55 7.25-5.25 7.25-10.1V6Z" />
    <path d="M9.25 12.1l2.1 2.1 3.7-3.85" />
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
  swap: (<>
    <path d="M7 8h10l-2.5-2.5" />
    <path d="M17 16H7l2.5 2.5" />
  </>),
  news: (<>
    <rect x="4" y="4.5" width="16" height="15" rx="2" />
    <path d="M8 9h8M8 12.5h8M8 16h5" />
  </>),
  redirect: (<>
    <path d="M5 12h7.5a3.5 3.5 0 0 0 3.5-3.5V5.5" />
    <path d="M13.5 8l2.5-2.5L18.5 8" />
    <path d="M12.5 12v6.5" />
    <path d="M10 16.5 12.5 19 15 16.5" />
  </>),
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
