import type { ReactNode } from "react";

/** USDC logo standing in for the token name. The name stays available to screen readers. */
export function Usdc({ label = "testUSDC" }: { label?: string }) {
  return <span className="usdc"><img src="/usdc.svg" alt="" /><span className="sr-only">{label}</span></span>;
}

/** Swaps the token name in a display string for the logo. Do not use on warnings or errors: they keep the name. */
export function withUsdc(text: string): ReactNode {
  return text.split(/(test ?USDC)/).map((part, index) => index % 2 ? <Usdc key={index} label={part} /> : part);
}
