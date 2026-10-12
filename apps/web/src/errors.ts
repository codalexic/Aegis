import { isRateLimited, isWalletRejected, isTransientRpcError } from "../../../packages/sdk/src/errors";
import { isNoDevnetSol } from "../../../packages/sdk/src/wallet-errors";
import { WALLET_CANCELLED, WALLET_REQUEST_FAILED } from "./wallet-lifecycle";

export const DEVNET_FAUCET_URL = "https://faucet.solana.com";
export const NO_DEVNET_SOL_MESSAGE = "Your wallet has no devnet SOL for fees. Get free devnet SOL, then try again.";

// Shared with the agent console so policy failures have the same explanation.
export const PROGRAM_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  CapExceeded: "This trade exceeds the vault’s per-trade cap.",
  BudgetExceeded: "This trade exceeds the vault’s remaining total budget.",
  AccountMismatch: "The output must stay in the vault; the attacker tried to redirect it.",
  Revoked: "The owner revoked the agent’s trading permission.",
  Expired: "The vault’s trading permission has expired.",
  Unauthorized: "This signer does not have permission to trade from the vault.",
  InvalidAmount: "The requested amount is invalid.",
  SwapResultMismatch: "The exchange did not deliver the required token balances.",
  InsufficientReserve: "The demo exchange does not have enough tokens for this trade.",
};

const RPC_BUSY = "The Solana devnet RPC is busy or rate limited. Wait a few seconds and try again.";
const WALLET_REJECTED = WALLET_CANCELLED;
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ...PROGRAM_ERROR_MESSAGES,
  RpcError: RPC_BUSY,
  RpcRateLimited: RPC_BUSY,
  RpcTransient: RPC_BUSY,
  BlockhashNotFound: RPC_BUSY,
  RateLimited: "Too many requests. Wait a few seconds and try again.",
  WalletRejected: WALLET_REJECTED,
  UserRejected: WALLET_REJECTED,
  SigningFailed: WALLET_REQUEST_FAILED,
  WalletModifiedTransaction: "Phantom changed the transaction in a way Aegis cannot safely approve. Nothing was sent. Try again.",
  InvalidWalletSignature: "The wallet returned an invalid signature. Nothing was sent. Reconnect Phantom and try again.",
  WalletSigningError: WALLET_REQUEST_FAILED,
  InsufficientFunds: "Not enough testUSDC in your wallet. Get 1,000 testUSDC first.",
  AccountAlreadyInUse: "This vault already exists. Use New demo vault to start again.",
  MintMismatch: "The token account uses the wrong mint. Reconnect your wallet and try again.",
  OwnerMismatch: "The token account belongs to a different wallet. Reconnect the correct wallet.",
  InvalidOwner: "The token account does not match its wallet address. Reconnect your wallet and try again.",
  AccountFrozen: "This token account is frozen. It cannot transfer tokens.",
  VaultNotFound: "This vault could not be found. Create a new demo vault.",
  VaultAlreadyExists: "This vault already exists. Use New demo vault to start again.",
  DeploymentProgramMismatch: "The demo’s program configuration does not match. Reload the page or contact the demo operator.",
  DeploymentAccountMismatch: "The demo’s account configuration does not match. Reload the page or contact the demo operator.",
  DeploymentClusterMismatch: "The RPC is connected to the wrong Solana cluster. Use Solana devnet and try again.",
  InvalidDevnetRpcUrl: "The devnet RPC address is invalid. Contact the demo operator.",
  InvalidTransaction: "The transaction could not be read. Refresh the page and try again.",
  TransactionExpired: "The transaction expired. Please try the action again.",
  ConfirmationTimedOut: "Confirmation is taking too long. Check your balance and activity before retrying.",
  TransactionFailed: "The transaction failed. Check your balance and try again.",
};

export interface ErrorDescription { text: string; code?: string; detail?: string; faucet?: boolean; tone?: "info" }
const FALLBACK = "Something went wrong. Try again.";

export function describeError(error: unknown): ErrorDescription {
  const value = error && typeof error === "object" ? error as { message?: unknown; code?: unknown; detail?: unknown } : undefined;
  const message = typeof error === "string" ? error.trim() : typeof value?.message === "string" ? value.message.trim() : "";

  // Both signing paths wrap a funding failure after successfully creating a vault.
  const funding = /^Vault created, but funding failed: (.+)\. Use Fund 1,000 to retry\.$/s.exec(message);
  if (funding) {
    const detail = describeError({ message: funding[1], detail: value?.detail });
    return { ...detail, text: `Vault created, but funding failed. ${detail.text} Use Fund 1,000 to retry.` };
  }

  if (message === WALLET_CANCELLED || message === "UserRejected" || isWalletRejected(error)) {
    return { text: WALLET_CANCELLED, tone: "info" };
  }
  if (message === WALLET_REQUEST_FAILED) return { text: message };

  if (isNoDevnetSol(error)) return { text: NO_DEVNET_SOL_MESSAGE, faucet: true };

  for (const code of [value?.code, message]) {
    if (typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code)) return {
      text: ERROR_MESSAGES[code],
    };
  }
  if (isWalletRejected(error)) return { text: WALLET_REJECTED };
  if (isRateLimited(error)) return { text: RPC_BUSY };

  if (isTransientRpcError(error)) return { text: RPC_BUSY };
  // Never render provider statuses, identifiers, stack traces or wallet diagnostics.
  if (value?.code !== undefined || /\bHTTP\b|\b[45]\d\d\b|\b[A-Za-z]+(?:Error|Exception)\b|0x[\da-f]+|custom program|blockhash|\bcode\s*[:=]/i.test(message) ||
      /\b(?:UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT)\b/.test(message) ||
      /\b\w*[a-z][A-Z]\w*\b|\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/.test(message.replace(/testUSDC|testSOL/g, "")) ||
      /^[\w.:-]+(?:\([^\s]*\))?$/.test(message)) return { text: FALLBACK };
  return { text: message || FALLBACK };
}
