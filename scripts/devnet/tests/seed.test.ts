import { address, createSolanaRpc } from "@solana/kit";
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveSwapAccounts } from "../../../packages/sdk/src/index";
import { connectLocalnet, type LocalnetContext } from "../../../tests/e2e/helpers";
import { OWNER_TOKENS, POOL_LIQUIDITY, seedDevnet } from "../seed";
import { AGENT_FUNDING, fundingBudget } from "../support";

// Exercise the future devnet setup against the running local validator, never public devnet.
describe("devnet seeding on localnet", () => {
  let f: LocalnetContext;
  beforeAll(async () => { f = await connectLocalnet(); });

  it("creates the mints/pool, funds the agent, and reruns without new minting or SOL transfers", async () => {
    const agent = Keypair.generate();
    const input = Keypair.generate();
    const output = Keypair.generate();
    await seedDevnet(f.client.connection, f.owner, agent, input, output, AGENT_FUNDING);
    const rpc = createSolanaRpc("http://127.0.0.1:8899");
    const balance = () => rpc.getBalance(address(agent.publicKey.toBase58()), { commitment: "confirmed" }).send();
    const agentBalance = (await balance()).value;
    expect(agentBalance).toBe(AGENT_FUNDING);
    const accounts = deriveSwapAccounts(f.owner.publicKey, input.publicKey, output.publicKey);
    const ownerInput = getAssociatedTokenAddressSync(input.publicKey, f.owner.publicKey);
    const snapshot = async () => ({
      input: await getMint(f.client.connection, input.publicKey, "confirmed"),
      output: await getMint(f.client.connection, output.publicKey, "confirmed"),
      tokens: (await getAccount(f.client.connection, ownerInput, "confirmed")).amount,
      reserve: (await getAccount(f.client.connection, accounts.outputReserve, "confirmed")).amount,
      agentBalance: (await balance()).value,
    });
    const before = await snapshot();
    expect(before.input).toMatchObject({ decimals: 6, mintAuthority: f.owner.publicKey, supply: OWNER_TOKENS });
    expect(before.output).toMatchObject({ decimals: 9, mintAuthority: f.owner.publicKey, supply: POOL_LIQUIDITY });
    expect(before.tokens).toBe(OWNER_TOKENS);
    expect(before.reserve).toBe(POOL_LIQUIDITY);
    const history = await f.client.connection.getSignaturesForAddress(input.publicKey, {}, "confirmed");
    await seedDevnet(f.client.connection, f.owner, agent, input, output, fundingBudget(0n, 0n, agentBalance).agentFunding);
    expect(await snapshot()).toEqual(before);
    expect(await f.client.connection.getSignaturesForAddress(input.publicKey, {}, "confirmed")).toEqual(history);
  }, 60_000);
});
