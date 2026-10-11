import { describeError, DEVNET_FAUCET_URL, type ErrorDescription } from "./errors";
import { Icon } from "./icons";

type NoticeProps = {
  className?: string;
  onDismiss?(): void;
  faucet?: boolean;
} & ({ tone: "error"; message: unknown } | { tone: "success" | "info" | "busy"; message: string });

export function Notice({ tone, message, className = "", onDismiss, faucet }: NoticeProps) {
  const detail: ErrorDescription = tone === "error" ? describeError(message) : { text: message };
  return <div className={`notice ${tone}${className ? ` ${className}` : ""}`} role={tone === "error" ? "alert" : "status"}>
    {tone !== "busy" && <Icon name={tone === "error" ? "alert" : tone === "success" ? "check" : "info"} size={16} />}
    <div className="notice-content"><p>{detail.text}{(detail.faucet || faucet) && <> <a href={DEVNET_FAUCET_URL} target="_blank" rel="noreferrer">Get free devnet SOL</a></>}</p>{(detail.detail || detail.code) && <small className="notice-code">{detail.detail || detail.code}</small>}</div>
    {onDismiss && <button type="button" className="icon-button notice-dismiss" aria-label="Dismiss" onClick={onDismiss}><Icon name="x" size={14} /></button>}
  </div>;
}
