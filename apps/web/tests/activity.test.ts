import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, transactionRecord, PRECISE_AMOUNT } from "../../../packages/sdk/tests/anchor-helpers";
import { actionDetail } from "../src/activity";

afterEach(() => vi.restoreAllMocks());

describe("chain activity labels and amounts", () => {
  it("decodes the requested amount of a rejected agent swap without JavaScript number conversion", async () => {
    const f = await fixture();
    await f.client.swapRaw(f.agent, f.accounts, PRECISE_AMOUNT);
    const record = transactionRecord(f.sent[0], { InstructionError: [0, { Custom: 6004 }] });
    expect(actionDetail(record, await f.client.getVault(f.vault))).toEqual({ label: "Agent swap", amount: "9007199254.740993 testUSDC" });
  });

  it.each(["create", "fund", "revoke", "withdraw"])("decodes %s after a page reload", async (action) => {
    const f = await fixture();
    if (action === "create") await f.client.createVault(f.owner, f.policy);
    if (action === "fund") await f.client.fundVault(f.owner, f.vault, 1_000_000_000n);
    if (action === "revoke") await f.client.revoke(f.owner, f.vault);
    if (action === "withdraw") await f.client.withdraw(f.owner, f.vault, f.outputMint, 200_000_000n);
    const expected: Record<string, { label: string; amount: string; destination?: string }> = {
      create: { label: "Create vault", amount: "0" }, fund: { label: "Fund vault", amount: "1000 testUSDC" },
      revoke: { label: "Revoke agent", amount: "0" }, withdraw: { label: "Withdraw", destination: "your wallet", amount: "0.2 testSOL" },
    };
    expect(actionDetail(transactionRecord(f.sent[0], null), await f.client.getVault(f.vault))).toEqual(expected[action]);
  });
});

it("decodes an extra withdrawal recipient after reload", async () => {
  const f = await fixture(), recipient = Keypair.generate().publicKey;
  await f.client.withdrawTo(f.owner, f.vault, f.outputMint, recipient, 200_000_000n);
  expect(actionDetail(transactionRecord(f.sent[0], null), await f.client.getVault(f.vault))).toEqual({
    label: "Withdraw", amount: "0.2 testSOL", destination: recipient.toBase58(),
  });
});
