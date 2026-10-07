import { DEVNET_RPC_URL, devnetFetch } from "./rpc-fetch";
// Public RPC reads shared by the dashboard and wallet client.
import { Buffer } from "buffer";
import { PublicKey, VersionedMessage, type VersionedTransactionResponse } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor/dist/esm/coder/borsh/accounts.js";
import { convertIdlToCamelCase } from "@coral-xyz/anchor/dist/esm/idl.js";
import { AccountLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Idl, IdlAccounts } from "@coral-xyz/anchor";
import type { Aegis } from "../../../artifacts/idl/aegis";
import idl from "../../../artifacts/idl/aegis.json";
import { AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID, deriveSwapAccounts, deriveVaultPda } from "./addresses";
import { ClientError, transactionErrorName } from "./errors";
import type { LocalnetDeployment, Activity, VaultState } from "./index";

type Account = { owner: string; executable: boolean; data: [string, "base64"] };
type Signature = { signature: string; slot: number; blockTime: number | null; err: unknown };
type WireTransaction = Omit<VersionedTransactionResponse, "transaction" | "meta"> & {
  transaction: [string, "base64"];
  meta: (Omit<NonNullable<VersionedTransactionResponse["meta"]>, "loadedAddresses"> & {
    loadedAddresses?: { writable: string[]; readonly: string[] };
  }) | null;
};

export class ChainReader {
  private readonly coder = new BorshAccountsCoder(convertIdlToCamelCase(idl as Idl));
  constructor(readonly deployment: LocalnetDeployment) {
    const url = new URL(deployment.rpcUrl);
    const validRpc = deployment.environment === "devnet" ? deployment.rpcUrl === DEVNET_RPC_URL
      : deployment.environment === "localnet" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!validRpc || url.username || url.password || deployment.programs.aegis !== AEGIS_PROGRAM_ID.toBase58() ||
        deployment.programs.demoDex !== DEMO_DEX_PROGRAM_ID.toBase58()) throw new ClientError("DeploymentProgramMismatch");
    const input = new PublicKey(deployment.inputMint), output = new PublicKey(deployment.outputMint);
    const expected = deriveSwapAccounts(PublicKey.default, input, output);
    if (input.equals(output) || (["pool", "poolAuthority", "inputReserve", "outputReserve"] as const)
      .some((key) => deployment[key] !== expected[key].toBase58())) throw new ClientError("DeploymentAccountMismatch");
  }

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    try {
      const fetcher = this.deployment.environment === "devnet" ? devnetFetch() : fetch;
      const response = await fetcher(this.deployment.rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (!response.ok || body.error || !("result" in body)) throw new Error();
      return body.result;
    } catch { throw new ClientError("RpcError"); }
  }

  async getVault(vault: PublicKey): Promise<VaultState> {
    const { value: info } = await this.rpc<{ value: Account | null }>("getAccountInfo", [vault.toBase58(), { encoding: "base64", commitment: "confirmed" }]);
    if (!info) throw new ClientError("VaultNotFound");
    try {
      const data = Buffer.from(info.data[0], "base64");
      if (info.data[1] !== "base64" || info.owner !== AEGIS_PROGRAM_ID.toBase58() || info.executable || data.length !== this.coder.size("vault")) throw new Error();
      const state = this.coder.decode<IdlAccounts<Aegis>["vault"]>("vault", data);
      const expected = deriveSwapAccounts(vault, state.inputMint, state.outputMint);
      if (!vault.equals(deriveVaultPda(state.owner, BigInt(state.vaultId.toString()))[0]) ||
          !state.inputVault.equals(expected.inputVault) || !state.outputVault.equals(expected.outputVault)) throw new Error();
      const { value: tokens } = await this.rpc<{ value: (Account | null)[] }>("getMultipleAccounts", [
        [state.inputVault.toBase58(), state.outputVault.toBase58()], { encoding: "base64", commitment: "confirmed" },
      ]);
      const [inputBalanceRaw, outputBalanceRaw] = tokens.map((token, index) => {
        if (!token || token.owner !== TOKEN_PROGRAM_ID.toBase58() || token.executable || token.data[1] !== "base64") throw new Error();
        const bytes = Buffer.from(token.data[0], "base64");
        if (bytes.length !== AccountLayout.span) throw new Error();
        const account = AccountLayout.decode(bytes);
        if (![1, 2].includes(account.state) || !account.owner.equals(expected.vaultAuthority) ||
            !account.mint.equals(index === 0 ? state.inputMint : state.outputMint)) throw new Error();
        return account.amount;
      });
      if (tokens.length !== 2) throw new Error();
      return { address: vault, owner: state.owner, agent: state.agent, inputMint: state.inputMint, outputMint: state.outputMint,
        maxTradeRaw: BigInt(state.maxTradeRaw.toString()), budgetRaw: BigInt(state.budgetRaw.toString()), spentRaw: BigInt(state.spentRaw.toString()),
        expiryUnix: BigInt(state.expiryUnix.toString()), revoked: state.revoked, inputBalanceRaw, outputBalanceRaw };
    } catch (error) { if (error instanceof ClientError) throw error; throw new ClientError("AccountMismatch"); }
  }

  async getTransaction(signature: string): Promise<VersionedTransactionResponse | null> {
    const value = await this.rpc<WireTransaction | null>("getTransaction", [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
    if (!value) return null;
    // Skip the compact-u16 signature count and signatures; decode only the public message.
    const bytes = Buffer.from(value.transaction[0], "base64");
    let count = 0, offset = 0, byte: number;
    do {
      if (offset >= 3 || offset >= bytes.length) throw new ClientError("InvalidTransaction");
      byte = bytes[offset]; count |= (byte & 127) << (7 * offset++);
    } while (byte & 128);
    const message = VersionedMessage.deserialize(bytes.subarray(offset + count * 64));
    const loaded = value.meta?.loadedAddresses;
    return { ...value, transaction: { message, signatures: [signature] }, meta: value.meta ? { ...value.meta,
      ...(loaded && { loadedAddresses: { writable: loaded.writable.map((key) => new PublicKey(key)), readonly: loaded.readonly.map((key) => new PublicKey(key)) } }),
    } as VersionedTransactionResponse["meta"] : null };
  }

  async listActivity(vault: PublicKey): Promise<Activity[]> {
    const activity: Activity[] = [];
    let before: string | undefined;
    for (;;) {
      const signatures = await this.rpc<Signature[]>("getSignaturesForAddress", [vault.toBase58(), { commitment: "confirmed", limit: 1000, before }]);
      for (const item of signatures) {
        const transaction = await this.getTransaction(item.signature);
        const err = transaction?.meta?.err ?? item.err;
        activity.push({ signature: item.signature, slot: BigInt(item.slot), ...(item.blockTime != null && { blockTime: BigInt(item.blockTime) }),
          ok: err === null, ...(err !== null && { error: transactionErrorName(err, transaction?.meta?.logMessages) }) });
      }
      if (signatures.length < 1000) return activity;
      before = signatures.at(-1)!.signature;
    }
  }
}
