import { isRateLimited, isWalletRejected } from "../../../packages/sdk/src/errors";

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
const WALLET_REJECTED = "The wallet request was declined. Try again and approve it in Phantom.";
const SOL_NEEDED = "Your wallet needs more SOL for transaction fees or account rent. Add SOL on this cluster and try again.";
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ...PROGRAM_ERROR_MESSAGES,
  RpcError: RPC_BUSY,
  RpcRateLimited: RPC_BUSY,
  RateLimited: "Too many requests. Wait a few seconds and try again.",
  WalletRejected: WALLET_REJECTED,
  UserRejected: WALLET_REJECTED,
  SigningFailed: "The wallet could not sign the transaction. Check Phantom and try again.",
  WalletModifiedTransaction: "Phantom changed the transaction in a way Aegis cannot safely approve. Nothing was sent. Try again.",
  InvalidWalletSignature: "The wallet returned an invalid signature. Nothing was sent. Reconnect Phantom and try again.",
  WalletSigningError: "Phantom could not sign the transaction. Check your wallet and try again.",
  InsufficientFunds: "Not enough testUSDC in your wallet. Get 1,000 testUSDC first.",
  NotRentExempt: SOL_NEEDED,
  ResultWithNegativeLamports: SOL_NEEDED,
  AccountAlreadyInUse: "This vault already exists. Use New demo vault to start again.",
  MintMismatch: "The token account uses the wrong mint. Reconnect your wallet and try again.",
  OwnerMismatch: "The token account belongs to a different wallet. Reconnect the correct wallet.",
  InvalidOwner: "The token account does not match its wallet address. Reconnect your wallet and try again.",
  AccountFrozen: "This token account is frozen. It cannot transfer tokens.",
  InsufficientFundsForFee: SOL_NEEDED,
  InsufficientFundsForRent: SOL_NEEDED,
  VaultNotFound: "This vault could not be found. Create a new demo vault.",
  VaultAlreadyExists: "This vault already exists. Use New demo vault to start again.",
  DeploymentProgramMismatch: "The demo’s program configuration does not match. Reload the page or contact the demo operator.",
  DeploymentAccountMismatch: "The demo’s account configuration does not match. Reload the page or contact the demo operator.",
  DeploymentClusterMismatch: "The RPC is connected to the wrong Solana cluster. Use Solana devnet and try again.",
  InvalidDevnetRpcUrl: "The devnet RPC address is invalid. Contact the demo operator.",
  InvalidTransaction: "The transaction could not be read. Refresh the page and try again.",
  TransactionExpired: "The transaction expired before confirmation. Check your balance and activity before retrying.",
  ConfirmationTimedOut: "Confirmation is taking too long. Check your balance and activity before retrying.",
  TransactionFailed: "The transaction failed. Check your balance and try again.",
};

export interface ErrorDescription { text: string; code?: string; detail?: string }
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

  for (const code of [value?.code, message]) {
    if (typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code)) return {
      text: ERROR_MESSAGES[code],
      ...(["WalletSigningError", "WalletModifiedTransaction"].includes(code) && typeof value?.detail === "string" && { detail: value.detail }),
    };
  }
  if (isWalletRejected(error)) return { text: WALLET_REJECTED };
  if (isRateLimited(error)) return { text: RPC_BUSY };
  if (/insufficient (?:SOL|lamports)|insufficient funds for (?:fees?|rent)|insufficient lamports/i.test(message)) return { text: SOL_NEEDED };

  // Keep existing actionable prose (for example, the faucet's ten-minute cooldown).
  // Unrecognised identifiers belong in the small diagnostic line, never the headline.
  const code = value?.code ?? (/^[\w.:-]+(?:\([^\s]*\))?$/.test(message) ? message : undefined);
  if (typeof code === "string" || typeof code === "number") return { text: FALLBACK, code: String(code) };
  return { text: message || FALLBACK };
}
