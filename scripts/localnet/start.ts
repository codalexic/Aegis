import { spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { address, createSolanaRpc, lamports } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  transfer,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import type { DemoDex } from "../../artifacts/idl/demo_dex";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rpcUrl = "http://127.0.0.1:8899";
const wsUrl = "ws://127.0.0.1:8900";
const keysDirectory = resolve(root, ".keys");
// The validator also creates private keys, so keep its ledger under .keys/.
const ledger = resolve(keysDirectory, "test-ledger");
const deploymentPath = resolve(root, "deployments/localnet.json");
const confirmOptions = { commitment: "confirmed", preflightCommitment: "confirmed" } as const;

async function loadOrCreateKeypair(name: string): Promise<Keypair> {
  const path = resolve(keysDirectory, `${name}.json`);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const keypair = Keypair.generate();
    await writeFile(path, JSON.stringify(Array.from(keypair.secretKey)), { flag: "wx", mode: 0o600 });
    return keypair;
  }
  try {
    const bytes: unknown = JSON.parse(contents);
    if (!Array.isArray(bytes) || bytes.length !== 64 ||
        !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new Error("Invalid keypair");
    }
    const keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    await chmod(path, 0o600);
    return keypair;
  } catch {
    // JSON parser errors can include file contents. Never report secret bytes.
    throw new Error(`Cannot load .keys/${name}.json; expected a valid Solana test keypair.`);
  }
}

async function requireFreePort(port: number) {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Localnet port ${port} is already in use; stop the existing process first.`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort()));
  });
}

async function waitForRpc() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && (await response.json()).result === "ok") return;
    } catch {
      // Connection refusal is expected while the validator starts.
    }
    await delay(500);
  }
  throw new Error(`RPC did not become healthy within 60 seconds. See ${ledger}/validator.log.`);
}

async function seedLocalnet(owner: Keypair, agent: Keypair, aegisId: PublicKey, dexIdl: DemoDex) {
  const connection = new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl });
  const rpc = createSolanaRpc(rpcUrl);
  for (const keypair of [owner, agent]) {
    const blockhash = await connection.getLatestBlockhash("confirmed");
    // Kit keeps native SOL amounts as bigint too.
    const signature = await rpc.requestAirdrop(address(keypair.publicKey.toBase58()), lamports(10_000_000_000n)).send();
    const confirmation = await connection.confirmTransaction({ signature, ...blockhash }, "confirmed");
    if (confirmation.value.err) throw new Error(`Local airdrop failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  // Reusing the mint keys keeps addresses stable across resets of this checkout.
  const inputKeypair = await loadOrCreateKeypair("test-usdc");
  const outputKeypair = await loadOrCreateKeypair("test-sol");
  const inputMint = await createMint(connection, owner, owner.publicKey, null, 6, inputKeypair, confirmOptions);
  const outputMint = await createMint(connection, owner, owner.publicKey, null, 9, outputKeypair, confirmOptions);
  const ownerInput = await getOrCreateAssociatedTokenAccount(connection, owner, inputMint, owner.publicKey, false, "confirmed", confirmOptions);
  const ownerOutput = await getOrCreateAssociatedTokenAccount(connection, owner, outputMint, owner.publicKey, false, "confirmed", confirmOptions);
  await mintTo(connection, owner, inputMint, ownerInput.address, owner, 10_000_000_000n, [], confirmOptions);

  const dex = new Program<DemoDex>(dexIdl, new AnchorProvider(connection, new Wallet(owner), confirmOptions));
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), inputMint.toBuffer(), outputMint.toBuffer()], dex.programId);
  const [poolAuthority] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), pool.toBuffer()], dex.programId);
  const inputReserve = getAssociatedTokenAddressSync(inputMint, poolAuthority, true);
  const outputReserve = getAssociatedTokenAddressSync(outputMint, poolAuthority, true);
  await dex.methods.initializePool().accountsStrict({
    payer: owner.publicKey, inputMint, outputMint, pool, poolAuthority, inputReserve, outputReserve,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).rpc();

  const liquidity = 1_000_000_000_000n;
  await mintTo(connection, owner, outputMint, ownerOutput.address, owner, liquidity, [], confirmOptions);
  await transfer(connection, owner, ownerOutput.address, outputReserve, owner, liquidity, [], confirmOptions);

  const deployment = {
    environment: "localnet", rpcUrl, wsUrl,
    programs: { aegis: aegisId.toBase58(), demoDex: dex.programId.toBase58() },
    owner: owner.publicKey.toBase58(), agent: agent.publicKey.toBase58(),
    inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
    pool: pool.toBase58(), poolAuthority: poolAuthority.toBase58(),
    inputReserve: inputReserve.toBase58(), outputReserve: outputReserve.toBase58(),
    ownerInput: ownerInput.address.toBase58(), ownerOutput: ownerOutput.address.toBase58(),
  };
  await mkdir(resolve(root, "deployments"), { recursive: true });
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`Localnet ready: ${rpcUrl}`);
  console.log("Owner funded with 10,000 testUSDC; pool funded with 1,000 testSOL.");
  console.log(`Pool: ${deployment.pool}`);
  console.log("Wrote deployments/localnet.json (public addresses only). Ctrl-C stops the validator.");
}

async function main() {
  for (const name of ["aegis", "demo_dex"]) {
    try {
      await access(resolve(root, `target/deploy/${name}.so`));
    } catch {
      throw new Error(`Missing target/deploy/${name}.so; run anchor build first.`);
    }
  }
  await Promise.all([8899, 8900, 9900].map(requireFreePort));
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  const owner = await loadOrCreateKeypair("owner");
  const agent = await loadOrCreateKeypair("agent");
  const aegisId = new PublicKey(JSON.parse(await readFile(resolve(root, "artifacts/idl/aegis.json"), "utf8")).address);
  const dexIdl: DemoDex = JSON.parse(await readFile(resolve(root, "artifacts/idl/demo_dex.json"), "utf8"));

  // An old deployment must not look ready while its chain is being reset.
  await rm(deploymentPath, { force: true });
  console.log("Starting a fresh local validator with aegis and demo_dex...");
  const validator = spawn("solana-test-validator", [
    "--reset", "--ledger", ledger, "--bind-address", "127.0.0.1", "--rpc-port", "8899",
    // Avoid depending on a globally configured CLI wallet on a clean machine.
    "--mint", owner.publicKey.toBase58(),
    "--bpf-program", aegisId.toBase58(), resolve(root, "target/deploy/aegis.so"),
    "--bpf-program", dexIdl.address, resolve(root, "target/deploy/demo_dex.so"),
    "--quiet",
  ], { cwd: root, stdio: "inherit", env: { ...process.env, NO_DNA: "1" } });

  let stopping = false;
  let failure: Error | undefined;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolveExit) => {
    validator.once("error", (error) => { failure = error; resolveExit(); });
    validator.once("exit", (code, signal) => {
      if (!stopping) failure = new Error(`Validator exited (${signal ?? code}). See ${ledger}/validator.log.`);
      resolveExit();
    });
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    validator.kill("SIGTERM");
    forceStop = setTimeout(() => validator.kill("SIGKILL"), 5_000);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await Promise.race([
      waitForRpc().then(() => seedLocalnet(owner, agent, aegisId, dexIdl)),
      exited.then(() => { throw failure ?? new Error("Localnet startup stopped."); }),
    ]);
    await exited;
    if (failure) throw failure;
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    stop();
    await exited;
    clearTimeout(forceStop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().then(() => process.exit(0), (error: unknown) => {
  console.error(error instanceof Error ? error.message : "Localnet startup failed.");
  process.exit(1);
});
