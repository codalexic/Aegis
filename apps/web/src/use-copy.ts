import { useEffect, useState } from "react";

/** Copies `text` to the clipboard; `copied` stays true for 1.5s afterwards. */
export function useCopy(text: string): [copied: boolean, copy: () => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => {}); };
  return [copied, copy];
}
