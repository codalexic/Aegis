import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { rawAmountToUi } from "../../packages/sdk/src/amounts";

export class DevnetError extends Error {}
export const sol = (lamports: bigint) => rawAmountToUi(lamports, 9);
// Explicit allowances, not a claim that future transaction fees are exactly predictable.
export const FEE_ALLOWANCE = 50_000_000n;
export const AGENT_FUNDING = 50_000_000n;

export async function inspectProgram(connection: Connection, id: PublicKey, binary: Buffer, authority: PublicKey) {
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const program = await connection.getAccountInfo(id, "confirmed");
  if (!program) return { exists: false, current: false };
  if (!program.executable || !program.owner.equals(loader) || program.data.length !== 36 || program.data.readUInt32LE() !== 2) {
    throw new DevnetError(`Program ${id.toBase58()} is already occupied by an unexpected account.`);
  }
  const dataAddress = new PublicKey(program.data.subarray(4, 36));
  const data = await connection.getAccountInfo(dataAddress, "confirmed");
  if (!data?.owner.equals(loader) || data.data.length < 45 || data.data.readUInt32LE() !== 3 || data.data[12] !== 1 ||
      !new PublicKey(data.data.subarray(13, 45)).equals(authority)) {
    throw new DevnetError(`Program ${id.toBase58()} has a different or immutable upgrade authority.`);
  }
  return { exists: true, dataAddress, current: data.data.subarray(45, 45 + binary.length).equals(binary) &&
    data.data.subarray(45 + binary.length).every((byte) => byte === 0) };
}

export function fundingBudget(programRent: bigint, setupRent: bigint, agentBalance: bigint, uploadBuffer = 0n) {
  const agentFunding = agentBalance < AGENT_FUNDING ? AGENT_FUNDING - agentBalance : 0n;
  return { programRent, setupRent, uploadBuffer, agentFunding, fees: FEE_ALLOWANCE,
    required: programRent + setupRent + uploadBuffer + agentFunding + FEE_ALLOWANCE };
}

export async function runFundedDeployment(balance: bigint, required: bigint, checkOnly: boolean, deploy: () => Promise<void>) {
  if (balance < required) {
    throw new DevnetError(`Insufficient devnet SOL: need ${sol(required)} SOL total; balance ${sol(balance)} SOL; add ${sol(required - balance)} SOL. No transactions sent. Fund the deployer at https://faucet.solana.com and rerun.`);
  }
  if (checkOnly) return;
  await deploy();
}

async function readKey(path: string): Promise<Keypair> {
  try {
    const bytes: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64 ||
        !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error();
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch { throw new DevnetError("Cannot read a deployment keypair; key contents withheld. Restore the key from your backup."); }
}

export async function loadOrCreateKey(root: string, name: string, expected?: string): Promise<Keypair> {
  const path = resolve(root, `.keys/${name}.json`);
  await mkdir(resolve(root, ".keys"), { recursive: true, mode: 0o700 });
  try { await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DevnetError(`Cannot access .keys/${name}.json.`);
    if (expected) throw new DevnetError(`Missing .keys/${name}.json for the existing deployment; restore it from backup.`);
    const key = Keypair.generate();
    await writeFile(path, JSON.stringify(Array.from(key.secretKey)), { flag: "wx", mode: 0o600 });
  }
  const key = await readKey(path);
  if (expected && key.publicKey.toBase58() !== expected) throw new DevnetError(`.keys/${name}.json does not match deployments/devnet.json.`);
  await chmod(path, 0o600);
  return key;
}

export async function backupProgramKey(root: string, name: string, expected: string): Promise<Keypair> {
  const source = resolve(root, `target/deploy/${name}-keypair.json`);
  const destination = resolve(root, `.keys/programs/${name}-keypair.json`);
  await mkdir(resolve(root, ".keys/programs"), { recursive: true, mode: 0o700 });
  try { await readFile(destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DevnetError("Cannot access the program backup directory.");
    const key = await readKey(source);
    if (key.publicKey.toBase58() !== expected) throw new DevnetError(`${name} key does not match the existing program ID; restore the original key.`);
    await writeFile(destination, await readFile(source), { flag: "wx", mode: 0o600 });
  }
  const key = await readKey(destination);
  if (key.publicKey.toBase58() !== expected) throw new DevnetError(`${name} backup does not match the existing program ID.`);
  await chmod(destination, 0o600);
  return key;
}

/** Only for read-only Kit RPC calls; amounts stay bigint from JSON decoding onward. */
export async function readRpc<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await request(AbortSignal.timeout(30_000)); }
    catch {
      if (attempt === 3) throw new DevnetError("Devnet RPC unavailable after retries; retry later. No automatic faucet requests are made.");
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
