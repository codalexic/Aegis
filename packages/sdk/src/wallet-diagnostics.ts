/** Extract only bounded prose, never error objects, stacks, URLs, or wire data. */
export function walletErrorDetail(error: unknown, depth = 0): string {
  if (depth > 4 || error == null) return "No wallet error message was provided.";
  const value = typeof error === "object" ? error as { message?: unknown; cause?: unknown; error?: unknown } : { message: error };
  if (typeof value.message !== "string" || !value.message.trim()) return walletErrorDetail(value.cause ?? value.error, depth + 1);
  return value.message
    .replace(/(?:https?|wss?):\/\/[^\s]+/gi, "[redacted URL]")
    .replace(/(?:secret[ _-]?key|private[ _-]?key|api[ _-]?key|access[ _-]?token|seed(?: phrase)?|mnemonic|recovery phrase|transaction|payload)\s*[:=][\s\S]*/gi, "[redacted data]")
    .replace(/\[[^\]]*\]|\{[\s\S]*\}/g, "[redacted data]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted data]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 240);
}

export function debugWalletFailure(step: string, code: string, reason?: string): void {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1") {
    // RPC program error strings are untrusted too. Never log them verbatim.
    const safeCode = walletErrorDetail(code);
    console.debug("[Aegis wallet]", {
      step,
      code: /^[A-Za-z][A-Za-z0-9]{0,63}(?:\(\d{1,10}\))?$/.test(safeCode) ? safeCode : "TransactionFailed",
      reason: walletErrorDetail(reason ?? code),
    });
  }
}
