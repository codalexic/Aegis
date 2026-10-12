import aegisIdl from "../../../artifacts/idl/aegis.json";
import dexIdl from "../../../artifacts/idl/demo_dex.json";
import type { TxResult } from "./types";

export class ClientError extends Error {
  constructor(message: string, readonly detail?: string) { super(message); }
}

export const RPC_RATE_LIMITED = "RpcRateLimited";
export const WALLET_REJECTED = "WalletRejected";
export class RpcError extends Error {}
export class ProgramError extends Error {}

export function isBlockhashNotFound(error: unknown): boolean {
  return matchesError(error, (value) => /blockhash[\s_-]*not[\s_-]*found/i.test(String(value.message ?? "")));
}

/** Transport/lifetime failures only. Never retry a policy or token-program rejection. */
export function isTransientRpcError(error: unknown): boolean {
  if (error instanceof ProgramError || isWalletRejected(error)) return false;
  if (isRateLimited(error) || isBlockhashNotFound(error)) return true;
  return matchesError(error, (value) => {
    const code = Number(value.status ?? value.code);
    return (code >= 500 && code <= 599) || [-32603, -32004, -32005, -32016].includes(code) ||
      /\b5\d\d\b|RpcError|RpcTransient|ConfirmationTimedOut|TransactionExpired|block.?height.?exceeded|block height.*exceed|node.*(?:behind|unhealthy|lag)|minimum context slot|\btimeout\b|timed out|TimeoutError|AbortError|fetch failed|failed to fetch|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|service unavailable|already.?processed/i
        .test(`${value.name ?? ""} ${value.message ?? ""} ${value.code ?? ""}`);
  });
}

/** Wallet adapters may wrap the provider error in `cause` or `error`. */
export function isRateLimited(error: unknown): boolean {
  return matchesError(error, (value) => value.status === 429 || value.code === 429 ||
    /\b429\b|rate.?limit|too many requests/i.test(String(value.message ?? "")));
}

export function isWalletRejected(error: unknown): boolean {
  return matchesError(error, (value) => value.code === 4001 ||
    /user rejected|user denied|transaction rejected|request rejected|user cancel(?:led|ed)|WalletRejected/i.test(String(value.message ?? "")));
}

function matchesError(error: unknown, test: (value: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (depth > 4 || error == null) return false;
  const value = typeof error === "object" ? error as Record<string, unknown> : { message: error };
  return test(value) || matchesError(value.cause, test, depth + 1) || matchesError(value.error, test, depth + 1) ||
    matchesError(value.data, test, depth + 1) || matchesError(value.err, test, depth + 1);
}

const errors = new Map([aegisIdl, dexIdl].map((idl) => [
  idl.address, new Map<number, string>(idl.errors.map(({ code, name }) => [code, name])),
]));
// Custom codes are local to each program, including errors propagated through CPI.
errors.set("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", new Map([
  [0, "NotRentExempt"], [1, "InsufficientFunds"], [3, "MintMismatch"],
  [4, "OwnerMismatch"], [17, "AccountFrozen"],
]));
errors.set("11111111111111111111111111111111", new Map([
  [0, "AccountAlreadyInUse"], [1, "ResultWithNegativeLamports"],
]));
errors.set("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", new Map([[0, "InvalidOwner"]]));

/** Numeric codes overlap across programs. Use runtime invocation/failure lines for attribution. */
export function programErrorName(logs: readonly string[] | null | undefined): string | undefined {
  const stack: string[] = [];
  for (const log of logs ?? []) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(log);
    if (invoke) { stack.push(invoke[1]); continue; }
    const anchor = /^Program log: AnchorError .*Error Number: (\d+)\./.exec(log);
    if (anchor) {
      const code = Number(anchor[1]); // Error code, never a token amount.
      return errors.get(stack.at(-1) ?? "")?.get(code) ?? `CustomProgramError(${code})`;
    }
    const failed = /^Program (\w+) failed: custom program error: (0x[\da-f]+|\d+)$/i.exec(log);
    if (failed) {
      const code = Number(failed[2]);
      return errors.get(failed[1])?.get(code) ?? `CustomProgramError(${code})`;
    }
    if (/^Program \w+ success$/.test(log)) stack.pop();
  }
  return undefined;
}

export function transactionErrorName(error: unknown, logs?: readonly string[] | null): string {
  const name = programErrorName(logs);
  if (name) return name;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "InstructionError" in error) {
    const detail = error.InstructionError;
    if (Array.isArray(detail)) {
      if (typeof detail[1] === "string") return detail[1];
      if (detail[1] && typeof detail[1].Custom === "number") return `CustomProgramError(${detail[1].Custom})`;
    }
  }
  return "TransactionFailed";
}

export function failure(error: unknown, signature?: string): Extract<TxResult, { ok: false }> {
  if (error instanceof ProgramError) return { ok: false, error: error.message, origin: "program", ...(signature && { signature }) };
  if (isRateLimited(error)) return { ok: false, error: RPC_RATE_LIMITED, origin: "rpc", ...(signature && { signature }) };
  if (error instanceof RpcError) return { ok: false, error: ["ConfirmationTimedOut", "BlockhashNotFound", "RpcTransient"].includes(error.message) ? error.message : "RpcError", origin: "rpc", ...(signature && { signature }) };
  if (error instanceof ClientError) return { ok: false, error: error.message, origin: "client", ...(error.detail && { detail: error.detail }), ...(signature && { signature }) };
  const logs = error && typeof error === "object" && "logs" in error ? error.logs : undefined;
  const name = Array.isArray(logs) && logs.every((log) => typeof log === "string") ? programErrorName(logs) : undefined;
  // Do not return arbitrary exception text: RPC/transport errors can contain configuration.
  return { ok: false, error: name ?? "RpcError", origin: name ? "program" : "rpc", ...(signature && { signature }) };
}
