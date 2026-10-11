import { describeError } from "./errors";
import { Icon } from "./icons";

type NoticeProps = {
  className?: string;
  onDismiss?(): void;
} & ({ tone: "error"; message: unknown } | { tone: "success" | "info" | "busy"; message: string });

export function Notice({ tone, message, className = "", onDismiss }: NoticeProps) {
  const detail = tone === "error" ? describeError(message) : { text: message, code: undefined, detail: undefined };
  return <div className={`notice ${tone}${className ? ` ${className}` : ""}`} role={tone === "error" ? "alert" : "status"}>
    {tone !== "busy" && <Icon name={tone === "error" ? "alert" : tone === "success" ? "check" : "info"} size={16} />}
    <div className="notice-content"><p>{detail.text}</p>{(detail.detail || detail.code) && <small className="notice-code">{detail.detail || detail.code}</small>}</div>
    {onDismiss && <button type="button" className="icon-button notice-dismiss" aria-label="Dismiss" onClick={onDismiss}><Icon name="x" size={14} /></button>}
  </div>;
}
