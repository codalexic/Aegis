import { transactionErrorName } from "./errors";

export const NO_DEVNET_SOL = "NoDevnetSol";

/** Recognize wallet fee/rent failures, including RPC and adapter wrappers. */
export function isNoDevnetSol(error: unknown, depth = 0): boolean {
  if (depth > 6 || error == null) return false;
  if (typeof error === "string") return /\b(?:NoDevnetSol|AccountNotFound|InsufficientFundsForFee|InsufficientFundsForRent|NotRentExempt|ResultWithNegativeLamports)\b|insufficient (?:SOL|lamports)|insufficient funds for (?:fees?|rent)/i.test(error);
  if (Array.isArray(error)) return error.some((value) => isNoDevnetSol(value, depth + 1));
  if (typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return Object.hasOwn(value, "InsufficientFundsForRent") ||
    ["message", "code", "cause", "error", "data", "err", "logs", "InstructionError"]
      .some((key) => isNoDevnetSol(value[key], depth + 1));
}

export function walletTransactionErrorName(error: unknown, logs?: readonly string[] | null): string {
  const name = transactionErrorName(error, logs);
  return isNoDevnetSol(error) || isNoDevnetSol(name) || isNoDevnetSol(logs) ? NO_DEVNET_SOL : name;
}
