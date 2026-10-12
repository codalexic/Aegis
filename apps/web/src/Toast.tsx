import type { ReactNode } from "react";
import { Notice } from "./Notice";

/** Floating stack for action feedback — does not shift page layout. */
export function ToastStack({ children }: { children: ReactNode }) {
  return <div className="toast-stack" data-testid="toast-stack">{children}</div>;
}

export function Toast(props: Parameters<typeof Notice>[0]) {
  return <Notice {...props} className={`toast${props.className ? ` ${props.className}` : ""}`} />;
}
