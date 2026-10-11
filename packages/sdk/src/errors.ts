import aegisIdl from "../../../artifacts/idl/aegis.json";
import dexIdl from "../../../artifacts/idl/demo_dex.json";
import type { TxResult } from "./types";

export class ClientError extends Error {}

export const RPC_RATE_LIMITED = "RPC rate limited, try again in a moment";
export const WALLET_REJECTED = "Transaction rejected in Phantom";
export class RpcError extends Error {}

/** Wallet adapters may wrap the provider error in `cause` or `error`. */
export function isRateLimited(error: unknown): boolean {
  return matchesError(error, (value) => value.status === 429 || value.code === 429 ||
    /\b429\b|rate.?limit|too many requests/i.test(String(value.message ?? "")));
}

export function isWalletRejected(error: unknown): boolean {
  return matchesError(error, (value) => value.code === 4001 ||
    /user rejected|user denied|transaction rejected|request rejected/i.test(String(value.message ?? "")));
}

function matchesError(error: unknown, test: (value: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (depth > 4 || error == null) return false;
  const value = typeof error === "object" ? error as Record<string, unknown> : { message: error };
  return test(value) || matchesError(value.cause, test, depth + 1) || matchesError(value.error, test, depth + 1);
}

const errors = new Map([aegisIdl, dexIdl].map((idl) => [
  idl.address, new Map<number, string>(idl.errors.map(({ code, name }) => [code, name])),
]));

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
  if (isRateLimited(error)) return { ok: false, error: RPC_RATE_LIMITED, origin: "rpc", ...(signature && { signature }) };
  if (error instanceof RpcError) return { ok: false, error: "RpcError", origin: "rpc", ...(signature && { signature }) };
  if (error instanceof ClientError) return { ok: false, error: error.message, origin: "client", ...(signature && { signature }) };
  const logs = error && typeof error === "object" && "logs" in error ? error.logs : undefined;
  const name = Array.isArray(logs) && logs.every((log) => typeof log === "string") ? programErrorName(logs) : undefined;
  // Do not return arbitrary exception text: RPC/transport errors can contain configuration.
  return { ok: false, error: name ?? "RpcError", origin: name ? "program" : "rpc", ...(signature && { signature }) };
}
