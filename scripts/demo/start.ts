import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Keypair, PublicKey, type Signer } from "@solana/web3.js";
import {
  AnchorAegisClient, MockAegisClient, deriveSwapAccounts, explorerTransactionUrl, rawAmountToUi,
  type AegisEnvironment, type ChainDeployment, type TxResult, type VaultState,
} from "../../packages/sdk/src/index";

class DemoError extends Error {}
const FUNDING = 1_000_000_000n;
const TRADE = 20_000_000n;
const BUDGET = 100_000_000n;

function requireDemo(condition: boolean, message: string): asserts condition {
  if (!condition) throw new DemoError(message);
}

async function loadKey(name: string, expected: string): Promise<Signer> {
  try {
    const bytes: unknown = JSON.parse(await readFile(new URL(`../../.keys/${name}.json`, import.meta.url), "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64 ||
        !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
    const key = Keypair.fromSecretKey(Uint8Array.from(bytes));
    if (key.publicKey.toBase58() !== expected) throw new Error();
    return key;
  } catch { throw new DemoError(`Cannot load .keys/${name}.json or its public key does not match the deployment.`); }
}

function mockIdentity(byte: number): Signer {
  return { publicKey: new PublicKey(new Uint8Array(32).fill(byte)),
    get secretKey(): Uint8Array { throw new DemoError("Mock identities cannot sign transactions."); } };
}

async function context(environment: AegisEnvironment) {
  if (environment === "mock") return {
    client: new MockAegisClient(), owner: mockIdentity(3), agent: mockIdentity(4), now: BigInt(Math.floor(Date.now() / 1000)),
  };
  let deployment: ChainDeployment;
  try { deployment = JSON.parse(await readFile(new URL(`../../deployments/${environment}.json`, import.meta.url), "utf8")); }
  catch { throw new DemoError(`Cannot read deployments/${environment}.json; run pnpm ${environment === "devnet" ? "devnet:deploy" : "localnet"} first.`); }
  requireDemo(deployment.environment === environment, "Deployment environment mismatch.");
  const client = new AnchorAegisClient({ deployment });
  let chainTime: number | null;
  try { chainTime = await client.connection.getBlockTime(await client.connection.getSlot("confirmed")); }
  catch { throw new DemoError(`${environment} RPC is unavailable; retry when the endpoint is healthy.`); }
  if (chainTime === null) throw new DemoError(`${environment} clock is unavailable; retry shortly.`);
  return { client, owner: await loadKey(environment === "devnet" ? "devnet-deployer" : "owner", deployment.owner),
    agent: await loadKey(environment === "devnet" ? "devnet-agent" : "agent", deployment.agent), now: BigInt(chainTime) };
}

async function main() {
  let help: boolean | undefined;
  try { ({ values: { help } } = parseArgs({ options: { help: { type: "boolean" } }, strict: true })); }
  catch { throw new DemoError("Usage: pnpm demo [--help]"); }
  if (help) {
    console.log("Usage: pnpm demo\nRun the scripted vault story on localnet (default). Start pnpm localnet first.\nAEGIS_ENV=devnet pnpm demo uses deployments/devnet.json after pnpm devnet:deploy.\nAEGIS_ENV=mock pnpm demo runs a labelled simulation without keys or RPC.");
    return;
  }
  const environment = process.env.AEGIS_ENV ?? "localnet";
  requireDemo(environment === "localnet" || environment === "mock" || environment === "devnet", "AEGIS_ENV must be localnet, devnet or mock.");
  const { client, owner, agent, now } = await context(environment);
  const expiryUnix = now + 3600n;
  console.log(`[${environment}] Aegis · scripted terminal demo`);
  console.log(environment === "mock" ? "Mock simulation. All transactions and balances are simulated."
    : `Test key · ${environment} only. Real transactions with test tokens.`);
  console.log("Cap 50 testUSDC · budget 100 testUSDC · expiry +1 hour\nScripted proposals; no AI provider is called.");
  let step = 0;
  async function title(text: string) {
    if (step > 0) await pause(1000);
    console.log(`\n[${environment}] ${++step}/8 · ${text}`);
  }
  function result(transaction: TxResult, expectedError?: string) {
    const expected = expectedError ? !transaction.ok && transaction.error === expectedError &&
      transaction.origin === (environment === "mock" ? "client" : "program") : transaction.ok;
    console.log(`  ${transaction.ok ? "✓ Success" : `✗ ${transaction.error} (${transaction.origin})`}`);
    if (transaction.signature) console.log(`  Signature: ${transaction.signature}`);
    if (transaction.signature && environment === "devnet") console.log(`  Explorer: ${explorerTransactionUrl(transaction.signature, environment)}`);
    requireDemo(Boolean(expected), `Unexpected result; expected ${expectedError ?? "Success"}. Demo stopped.`);
    requireDemo(Boolean(transaction.signature) && transaction.signature!.startsWith("mock-") === (environment === "mock"),
      "Missing or incorrectly labelled transaction signature. Demo stopped.");
  }
  function balances(state: VaultState) {
    console.log(`  Balances: ${rawAmountToUi(state.inputBalanceRaw, 6)} testUSDC / ${rawAmountToUi(state.outputBalanceRaw, 9)} testSOL`);
    console.log(`  Spent: ${rawAmountToUi(state.spentRaw, 6)} testUSDC · remaining budget: ${rawAmountToUi(state.budgetRaw - state.spentRaw, 6)} testUSDC · revoked: ${state.revoked}`);
  }

  await title("Create vault");
  // A new nonzero ID allows consecutive runs without reusing a revoked vault or the dashboard's ID 0.
  const created = await client.createVault(owner, { vaultId: randomBytes(8).readBigUInt64LE() | 1n,
    agent: agent.publicKey, maxTradeRaw: 50_000_000n, budgetRaw: BUDGET, expiryUnix });
  result(created);
  requireDemo(created.vault !== undefined, "The SDK did not return a vault address.");
  const vault = created.vault;
  console.log(`  Vault: ${vault.toBase58()}`);
  async function state(input: bigint, output: bigint, spent: bigint, revoked = false) {
    const value = await client.getVault(vault);
    requireDemo(value.owner.equals(owner.publicKey) && value.agent.equals(agent.publicKey) &&
      value.maxTradeRaw === 50_000_000n && value.budgetRaw === BUDGET && value.expiryUnix === expiryUnix &&
      value.inputBalanceRaw === input && value.outputBalanceRaw === output && value.spentRaw === spent && value.revoked === revoked,
    "Vault state differs from the expected demo outcome. Demo stopped.");
    balances(value);
    return value;
  }
  async function blocked(send: () => Promise<TxResult>, error: string) {
    const before = await client.getVault(vault);
    result(await send(), error);
    const after = await client.getVault(vault);
    requireDemo(isDeepStrictEqual(after, before), "Rejected trade changed vault balances, spent or policy. Demo stopped.");
    balances(after);
    console.log("  Verified: vault balances and spent are unchanged.");
  }
  await state(0n, 0n, 0n);

  await title("Fund 1,000 testUSDC");
  result(await client.fundVault(owner, vault, FUNDING));
  await state(FUNDING, 0n, 0n);

  await title("Normal swap · 20 testUSDC");
  result(await client.swap(agent, vault, TRADE));
  await state(FUNDING - TRADE, 200_000_000n, TRADE);

  await title("Injected attack · scripted request for 1,000 testUSDC");
  await blocked(() => client.swap(agent, vault, FUNDING), "CapExceeded");

  await title("Redirect attack · 20 testUSDC to an attacker destination");
  const current = await client.getVault(vault);
  // The agent acts as attacker using its own valid testSOL token account.
  const attacker = getAssociatedTokenAddressSync(current.outputMint, agent.publicKey, environment === "mock");
  let attackerBefore = 0n;
  if (client instanceof AnchorAegisClient) {
    attackerBefore = (await getOrCreateAssociatedTokenAccount(client.connection, owner, current.outputMint,
      agent.publicKey, false, "confirmed", { commitment: "confirmed", preflightCommitment: "confirmed" })).amount;
  }
  console.log(`  Attacker token account: ${attacker.toBase58()}`);
  await blocked(() => client.swapRaw(agent, { ...deriveSwapAccounts(vault, current.inputMint, current.outputMint), outputVault: attacker }, TRADE), "AccountMismatch");
  if (client instanceof AnchorAegisClient) requireDemo((await getAccount(client.connection, attacker, "confirmed")).amount === attackerBefore,
    "Redirect attempt changed the attacker balance. Demo stopped.");

  await title("Owner revokes agent");
  result(await client.revoke(owner, vault));
  await state(FUNDING - TRADE, 200_000_000n, TRADE, true);

  await title("Agent tries another 20 testUSDC swap after revocation");
  await blocked(() => client.swap(agent, vault, TRADE), "Revoked");

  await title("Owner withdraws all funds");
  for (const [mint, amount, decimals, symbol] of [
    [current.inputMint, FUNDING - TRADE, 6, "testUSDC"], [current.outputMint, 200_000_000n, 9, "testSOL"],
  ] as const) {
    const destination = getAssociatedTokenAddressSync(mint, owner.publicKey, environment === "mock");
    const before = client instanceof AnchorAegisClient ? (await getAccount(client.connection, destination, "confirmed")).amount : 0n;
    console.log(`  Withdraw ${rawAmountToUi(amount, decimals)} ${symbol} to owner`);
    result(await client.withdraw(owner, vault, mint, amount));
    if (client instanceof AnchorAegisClient) requireDemo((await getAccount(client.connection, destination, "confirmed")).amount === before + amount,
      "Owner did not receive the withdrawn tokens. Demo stopped.");
  }
  await state(0n, 0n, TRADE, true);
  console.log(`\n[${environment}] Demo complete: 8/8 steps passed; 3 attacks blocked; vault revoked and empty.`);
}

void main().catch((error: unknown) => {
  // Key/JSON/RPC exceptions can contain private contents; print only our controlled errors.
  console.error(error instanceof DemoError ? error.message : "Demo failed unexpectedly; check the selected environment and local configuration.");
  process.exitCode = 1;
});
