import { describeError, DEVNET_FAUCET_URL, type ErrorDescription } from "./errors";
import { Icon } from "./icons";

type NoticeProps = {
  className?: string;
  onDismiss?(): void;
  faucet?: boolean;
} & ({ tone: "error"; message: unknown } | { tone: "success" | "info" | "busy"; message: string });

export function Notice({ tone, message, className = "", onDismiss, faucet }: NoticeProps) {
  const detail: ErrorDescription = tone === "error" ? describeError(message) : { text: message };
  const displayTone = detail.tone ?? tone;
  return <div className={`notice ${displayTone}${className ? ` ${className}` : ""}`} role={displayTone === "error" ? "alert" : "status"}>
    {displayTone !== "busy" && <Icon name={displayTone === "error" ? "alert" : displayTone === "success" ? "check" : "info"} size={16} />}
    <div className="notice-content"><p>{detail.text}{(detail.faucet || faucet) && <> <a href={DEVNET_FAUCET_URL} target="_blank" rel="noreferrer">Get free devnet SOL</a></>}</p></div>
    {onDismiss && <button type="button" className="icon-button notice-dismiss" aria-label="Dismiss" onClick={onDismiss}><Icon name="x" size={14} /></button>}
  </div>;
}
