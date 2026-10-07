import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAccount, mintTo } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "vitest";
import {
  AnchorAegisClient, deriveSwapAccounts, type LocalnetDeployment, type TxResult,
} from "../../packages/sdk/src/index";

export const FUNDING = 1_000_000_000n;
export const TRADE = 20_000_000n;
export const confirmOptions = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;

async function loadKey(name: "owner" | "agent", expected: string) {
  try {
    const bytes: unknown = JSON.parse(await readFile(new URL(`../../.keys/${name}.json`, import.meta.url), "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64 ||
        !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
    const key = Keypair.fromSecretKey(Uint8Array.from(bytes));
    if (key.publicKey.toBase58() !== expected) throw new Error();
    return key;
  } catch {
    // Parser errors can contain key bytes. Report only this controlled message.
    throw new Error(`Cannot load the localnet ${name} test key; run pnpm localnet first.`);
  }
}

export async function connectLocalnet() {
  const deployment: LocalnetDeployment = JSON.parse(await readFile(new URL("../../deployments/localnet.json", import.meta.url), "utf8"));
  const client = new AnchorAegisClient({ deployment });
  try { await client.connection.getLatestBlockhash("confirmed"); }
  catch { throw new Error("Localnet RPC is unavailable; keep pnpm localnet running while testing."); }
  const owner = await loadKey("owner", deployment.owner);
  const agent = await loadKey("agent", deployment.agent);
  return {
    client, owner, agent,
    inputMint: new PublicKey(deployment.inputMint), outputMint: new PublicKey(deployment.outputMint),
    ownerInput: new PublicKey(deployment.ownerInput), ownerOutput: new PublicKey(deployment.ownerOutput),
  };
}
export type LocalnetContext = Awaited<ReturnType<typeof connectLocalnet>>;

export function assertSuccess(result: TxResult): string {
  expect(result).toMatchObject({ ok: true, signature: expect.any(String) });
  if (!result.ok) throw new Error(`Expected success, received ${result.error}.`);
  expect(result.signature).not.toMatch(/^mock-/);
  return result.signature;
}

export async function freshVault(context: LocalnetContext) {
  const { client, owner, agent, inputMint, outputMint, ownerInput } = context;
  const chainTime = await client.connection.getBlockTime(await client.connection.getSlot("confirmed"));
  if (chainTime === null) throw new Error("Localnet did not return its clock.");
  // A new nonzero u64 ID per case/run leaves the dashboard's ID 0 vault alone.
  const policy = { vaultId: randomBytes(8).readBigUInt64LE() | 1n, agent: agent.publicKey,
    maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, expiryUnix: BigInt(chainTime) + 3600n };
  const created = await client.createVault(owner, policy);
  assertSuccess(created);
  if (!created.vault) throw new Error("The SDK did not return the created vault.");
  // Mint test tokens before funding so repeated runs cannot exhaust the demo owner's supply.
  await mintTo(client.connection, owner, inputMint, ownerInput, owner, FUNDING, [], confirmOptions);
  assertSuccess(await client.fundVault(owner, created.vault, FUNDING));
  expect(await client.getVault(created.vault)).toEqual({
    address: created.vault, owner: owner.publicKey, agent: agent.publicKey, inputMint, outputMint,
    maxTradeRaw: policy.maxTradeRaw, budgetRaw: policy.budgetRaw, expiryUnix: policy.expiryUnix,
    spentRaw: 0n, revoked: false, inputBalanceRaw: FUNDING, outputBalanceRaw: 0n,
  });
  return { ...context, vault: created.vault, accounts: deriveSwapAccounts(created.vault, inputMint, outputMint) };
}
export type Fixture = Awaited<ReturnType<typeof freshVault>>;

export async function tokenBalance(context: LocalnetContext, account: PublicKey) {
  return (await getAccount(context.client.connection, account, "confirmed")).amount;
}

export async function snapshot(f: Fixture) {
  return {
    vault: await f.client.getVault(f.vault),
    inputReserve: await tokenBalance(f, f.accounts.inputReserve),
    outputReserve: await tokenBalance(f, f.accounts.outputReserve),
  };
}

export async function assertRejected(f: Fixture, error: string, send: () => Promise<TxResult>) {
  const before = await snapshot(f);
  const result = await send();
  expect(result).toMatchObject({ ok: false, origin: "program", error, signature: expect.any(String) });
  expect(await snapshot(f)).toEqual(before); // Both balances, spent, policy and pool reserves.
  await expect.poll(async () => (await f.client.listActivity(f.vault)).find((item) => item.signature === result.signature),
    { timeout: 10_000 }).toMatchObject({ ok: false, error });
}

export async function nextBlockhash(f: Fixture, signature: string) {
  const transaction = await f.client.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
  expect(transaction?.meta?.err).toBeNull();
  if (!transaction) throw new Error("Confirmed swap is missing from RPC history.");
  // Identical legacy messages with the same blockhash are the same transaction.
  // Wait for a new hash so the next 20-token request is a new swap, not a replay.
  await expect.poll(async () => (await f.client.connection.getLatestBlockhash("confirmed")).blockhash,
    { timeout: 10_000, interval: 100 }).not.toBe(transaction.transaction.message.recentBlockhash);
}
