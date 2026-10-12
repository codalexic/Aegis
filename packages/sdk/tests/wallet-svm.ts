import { address, getTransactionDecoder } from "@solana/kit";
import { createAssociatedTokenAccountInstruction, createMintToInstruction } from "@solana/spl-token";
import { VersionedTransaction } from "@solana/web3.js";
import { encode } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { FailedTransactionMetadata } from "litesvm";
import { vi } from "vitest";
import { assertSuccess, createFixture, FUNDING, NOW, send } from "../../../tests/program/helpers";
import { AEGIS_PROGRAM_ID, deriveSwapAccounts } from "../src/addresses";
import { WalletAegisClient, type WalletSigner } from "../src/wallet";

/** Real wallet instructions executed by LiteSVM; only the RPC transport is replaced. */
export function walletSvm(balance = FUNDING, hasAta = true) {
  const f = createFixture();
  if (hasAta) assertSuccess(send(f.svm, [
    createAssociatedTokenAccountInstruction(f.owner.publicKey, f.ownerInput, f.owner.publicKey, f.inputMint),
    createMintToInstruction(f.inputMint, f.ownerInput, f.owner.publicKey, balance),
  ], [f.owner]));
  const accounts = deriveSwapAccounts(f.vault, f.inputMint, f.outputMint);
  const deployment = {
    environment: "localnet" as const, rpcUrl: "http://127.0.0.1:8899", wsUrl: "ws://127.0.0.1:8900",
    programs: { aegis: AEGIS_PROGRAM_ID.toBase58(), demoDex: accounts.demoDexProgram.toBase58() },
    owner: f.owner.publicKey.toBase58(), agent: f.agent.publicKey.toBase58(),
    inputMint: f.inputMint.toBase58(), outputMint: f.outputMint.toBase58(),
    pool: accounts.pool.toBase58(), poolAuthority: accounts.poolAuthority.toBase58(),
    inputReserve: accounts.inputReserve.toBase58(), outputReserve: accounts.outputReserve.toBase58(),
    ownerInput: f.ownerInput.toBase58(), ownerOutput: f.ownerOutput.toBase58(),
  };
  const decoder = getTransactionDecoder();
  const wireAccount = (key: string) => {
    const info = f.svm.getAccount(address(key));
    return info.exists ? { owner: info.programAddress, executable: info.executable,
      data: [Buffer.from(info.data).toString("base64"), "base64"] } : null;
  };
  const logs: string[][] = [];
  const confirmedSignatures = new Set<string>();
  const rpc = vi.fn(async (method: string, params: unknown[]): Promise<any> => {
    if (method === "getSlot") return 1;
    if (method === "getBlockTime") return Number(NOW);
    if (method === "getAccountInfo") return { value: wireAccount(params[0] as string) };
    if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map(wireAccount) };
    if (method === "getLatestBlockhash") return { value: { blockhash: f.svm.latestBlockhash(), lastValidBlockHeight: 999 } };
    if (method === "simulateTransaction") {
      f.svm.withSigverify(false);
      const result = f.svm.simulateTransaction(decoder.decode(Buffer.from(params[0] as string, "base64")));
      f.svm.withSigverify(true);
      const entries = result.meta().logs();
      logs.push(entries);
      return { value: { err: result instanceof FailedTransactionMetadata ? "TransactionFailed" : null, logs: entries } };
    }
    if (method === "sendTransaction") {
      const bytes = Buffer.from(params[0] as string, "base64");
      assertSuccess(f.svm.sendTransaction(decoder.decode(bytes)));
      f.svm.expireBlockhash();
      const signature = encode(VersionedTransaction.deserialize(bytes).signatures[0]);
      confirmedSignatures.add(signature);
      return signature;
    }
    if (method === "getSignatureStatuses") return { value: (params[0] as string[]).map((signature) => confirmedSignatures.has(signature) ? { err: null, confirmationStatus: "confirmed" } : null) };
    throw new Error(`Unexpected RPC method: ${method}`);
  });
  const sign = vi.fn<WalletSigner["signTransaction"]>(async (transaction) => {
    const signed = VersionedTransaction.deserialize(transaction.serialize());
    signed.sign([f.owner]);
    return signed;
  });
  const wallet = { publicKey: f.owner.publicKey, signTransaction: sign };
  const client = new WalletAegisClient(deployment);
  vi.spyOn(client, "rpc").mockImplementation(rpc);
  return { ...f, client, wallet, sign, rpc, logs, deployment,
    params: { ...f.policy, agent: f.agent.publicKey } };
}
