import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { address, createSolanaRpc } from "@solana/kit";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PublicKey } from "@solana/web3.js";
import {
  AEGIS_PROGRAM_ID, DEMO_DEX_PROGRAM_ID, createDevnetConnection, deriveSwapAccounts,
  DEVNET_RPC_URL, DEVNET_WS_URL, type ChainDeployment,
} from "../../packages/sdk/src/index";
import { backupProgramKey, DevnetError, fundingBudget, inspectProgram, loadOrCreateKey, readRpc, runFundedDeployment, sol } from "./support";
import { seedDevnet } from "./seed";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = resolve(root, "deployments/devnet.json");

async function deployProgram(name: string, size: number) {
  console.log(`Deploying ${name} on devnet with the existing program ID...`);
  const args = ["program", "deploy", resolve(root, `target/deploy/${name}.so`),
    "--url", DEVNET_RPC_URL, "--commitment", "confirmed",
    "--keypair", resolve(root, ".keys/devnet-deployer.json"),
    "--upgrade-authority", resolve(root, ".keys/devnet-deployer.json"),
    "--program-id", resolve(root, `.keys/programs/${name}-keypair.json`),
    "--buffer", resolve(root, `.keys/devnet-${name}-buffer.json`),
    "--max-len", String(size), "--with-compute-unit-price", "0", "--use-rpc", "--max-sign-attempts", "3",
    "--output", "json"];
  await new Promise<void>((resolveExit, reject) => {
    // Persistent buffer keys allow safe retries and prevent CLI recovery seed phrases.
    // Do not forward arbitrary subprocess output (including possible signing diagnostics).
    const child = spawn("solana", args, { cwd: root, stdio: "ignore", env: { ...process.env, NO_DNA: "1" } });
    child.once("error", () => reject(new DevnetError("Could not start the pinned Solana CLI.")));
    child.once("exit", (code) => code === 0 ? resolveExit() : reject(new DevnetError(
      `${name} deployment failed (exit ${code}); its upload buffer key is preserved in .keys/. Check devnet RPC/funding and rerun to resume.`)));
  });
}

async function main() {
  let checkOnly: boolean;
  try {
    const { values } = parseArgs({ options: { check: { type: "boolean", default: false } }, strict: true });
    checkOnly = values.check;
  } catch { throw new DevnetError("Usage: pnpm devnet:deploy [--check] (check never sends transactions)."); }

  // Backup both program identities before any build, account creation or deployment.
  await backupProgramKey(root, "aegis", AEGIS_PROGRAM_ID.toBase58());
  await backupProgramKey(root, "demo_dex", DEMO_DEX_PROGRAM_ID.toBase58());
  let existing: ChainDeployment | undefined;
  try { existing = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DevnetError("Cannot read deployments/devnet.json; fix the public manifest before continuing.");
  }
  if (existing && (existing.environment !== "devnet" || existing.rpcUrl !== DEVNET_RPC_URL ||
      existing.programs.aegis !== AEGIS_PROGRAM_ID.toBase58() || existing.programs.demoDex !== DEMO_DEX_PROGRAM_ID.toBase58())) {
    throw new DevnetError("Existing devnet manifest has unexpected environment or program IDs.");
  }
  const owner = await loadOrCreateKey(root, "devnet-deployer", existing?.owner);
  console.log(`Devnet deployer: ${owner.publicKey.toBase58()}`);
  const connection = createDevnetConnection();
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const getBalance = async (key: PublicKey) => (await readRpc((signal) => rpc.getBalance(address(key.toBase58()), { commitment: "confirmed" }).send({ abortSignal: signal }))).value;
  const balance = await getBalance(owner.publicKey);
  const rent = (size: number) => readRpc((signal) => rpc.getMinimumBalanceForRentExemption(BigInt(size)).send({ abortSignal: signal }));
  const agent = await loadOrCreateKey(root, "devnet-agent", existing?.agent);
  const input = await loadOrCreateKey(root, "devnet-test-usdc", existing?.inputMint);
  const output = await loadOrCreateKey(root, "devnet-test-sol", existing?.outputMint);
  const accounts = deriveSwapAccounts(owner.publicKey, input.publicKey, output.publicKey);
  const ownerInput = getAssociatedTokenAddressSync(input.publicKey, owner.publicKey);
  const ownerOutput = getAssociatedTokenAddressSync(output.publicKey, owner.publicKey);
  if (existing && (existing.pool !== accounts.pool.toBase58() || existing.poolAuthority !== accounts.poolAuthority.toBase58() ||
      existing.inputReserve !== accounts.inputReserve.toBase58() || existing.outputReserve !== accounts.outputReserve.toBase58() ||
      existing.ownerInput !== ownerInput.toBase58() || existing.ownerOutput !== ownerOutput.toBase58())) {
    throw new DevnetError("Existing devnet manifest has unexpected pool or token accounts.");
  }

  const programs: { name: string; id: PublicKey; binary: Buffer; exists: boolean; current: boolean }[] = [];
  let programRent = 0n;
  let uploadBuffer = 0n;
  const programAccountRent = await rent(36);
  for (const [name, id] of [["aegis", AEGIS_PROGRAM_ID], ["demo_dex", DEMO_DEX_PROGRAM_ID]] as const) {
    let binary: Buffer;
    try { binary = await readFile(resolve(root, `target/deploy/${name}.so`)); }
    catch { throw new DevnetError(`Missing target/deploy/${name}.so; run anchor build first.`); }
    if (!binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new DevnetError(`Invalid ${name}.so; run anchor build.`);
    await loadOrCreateKey(root, `devnet-${name}-buffer`);
    const state = await inspectProgram(connection, id, binary, owner.publicKey);
    const dataRent = await rent(binary.length + 45);
    if (!state.current) {
      // Initial deployment moves the funded upload buffer into ProgramData (not double rent).
      if (!state.exists) programRent += dataRent + programAccountRent;
      else {
        // Account growth remains locked; the upgrade buffer is a temporary reserve.
        const funded = await getBalance(state.dataAddress!);
        if (funded < dataRent) programRent += dataRent - funded;
        uploadBuffer = uploadBuffer > dataRent ? uploadBuffer : dataRent;
      }
    }
    console.log(`${name}: ${binary.length} bytes; ${state.current ? "already deployed, byte-for-byte identical" :
      `${state.exists ? "upgrade buffer" : "program rent"} ${sol(dataRent + (state.exists ? 0n : programAccountRent))} SOL`}.`);
    programs.push({ name, id, binary, ...state });
  }
  // Mint (82), token account (165), and generated Pool (8 + four Pubkeys + two bumps).
  const setup = [
    [input.publicKey, 82], [output.publicKey, 82], [accounts.pool, 138],
    [accounts.inputReserve, 165], [accounts.outputReserve, 165], [ownerInput, 165], [ownerOutput, 165],
  ] as const;
  const present = await connection.getMultipleAccountsInfo(setup.map(([key]) => key), "confirmed");
  let setupRent = 0n;
  const rents = new Map<number, bigint>();
  for (let i = 0; i < setup.length; i++) if (!present[i]) {
    const size = setup[i][1];
    if (!rents.has(size)) rents.set(size, await rent(size));
    setupRent += rents.get(size)!;
  }
  const agentBalance = await getBalance(agent.publicKey);
  const budget = fundingBudget(programRent, setupRent, agentBalance, uploadBuffer);
  console.log(`Setup account rent: ${sol(budget.setupRent)} SOL; agent fee funding: ${sol(budget.agentFunding)} SOL; transaction fee allowance: ${sol(budget.fees)} SOL.`);
  console.log(`Required balance: ${sol(budget.required)} SOL (${budget.required} lamports). Current balance: ${sol(balance)} SOL.`);
  console.log("This is a funding threshold; actual fees can vary. Unused SOL remains in the deployer. RPC rent is re-quoted on every run.");
  await runFundedDeployment(balance, budget.required, checkOnly, async () => {
    for (const program of programs) if (!program.current) {
      await deployProgram(program.name, program.binary.length);
      if (!(await inspectProgram(connection, program.id, program.binary, owner.publicKey)).current) {
        throw new DevnetError(`${program.name} did not match the built binary after deployment.`);
      }
    }
    await seedDevnet(connection, owner, agent, input, output, budget.agentFunding);
    const deployment: ChainDeployment = {
      environment: "devnet", rpcUrl: DEVNET_RPC_URL, wsUrl: DEVNET_WS_URL,
      programs: { aegis: AEGIS_PROGRAM_ID.toBase58(), demoDex: DEMO_DEX_PROGRAM_ID.toBase58() },
      owner: owner.publicKey.toBase58(), agent: agent.publicKey.toBase58(),
      inputMint: input.publicKey.toBase58(), outputMint: output.publicKey.toBase58(),
      pool: accounts.pool.toBase58(), poolAuthority: accounts.poolAuthority.toBase58(),
      inputReserve: accounts.inputReserve.toBase58(), outputReserve: accounts.outputReserve.toBase58(),
      ownerInput: ownerInput.toBase58(), ownerOutput: ownerOutput.toBase58(),
      ...(existing?.lastVault && { lastVault: existing.lastVault }),
    };
    await mkdir(resolve(root, "deployments"), { recursive: true });
    await writeFile(`${manifestPath}.tmp`, `${JSON.stringify(deployment, null, 2)}\n`);
    await rename(`${manifestPath}.tmp`, manifestPath);
    console.log("Devnet ready: wrote deployments/devnet.json (public addresses only). Run AEGIS_ENV=devnet pnpm demo.");
  });
  if (checkOnly) console.log("Funding check passed. --check: no transactions sent and no deployment manifest written.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof DevnetError ? error.message : "Devnet setup failed. Check RPC availability and the local configuration; signing details withheld.");
  process.exitCode = 1;
});
