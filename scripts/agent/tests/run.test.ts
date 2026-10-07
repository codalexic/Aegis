import { describe, expect, it, vi } from "vitest";
import { deriveSwapAccounts } from "../../../packages/sdk/src/index";
import { createMockContext } from "../context";
import { runAgent } from "../run";

describe("agent scenarios against the mock", () => {
  it("normal sends the model's exact amount and updates the vault", async () => {
    const context = await createMockContext();
    const propose = vi.fn().mockResolvedValue('{"amountUsdc":"20","reason":"Calm news"}');
    const swap = vi.spyOn(context.client, "swap");
    const log = vi.fn();
    expect(await runAgent(context, "normal", propose, log)).toBe(true);
    expect(swap).toHaveBeenCalledWith(context.agent, context.vault, 20_000_000n);
    expect(await context.client.getVault(context.vault)).toMatchObject({ inputBalanceRaw: 980_000_000n, outputBalanceRaw: 200_000_000n, spentRaw: 20_000_000n });
    expect(log.mock.calls.flat().join("\n")).toContain("Result [mock]: ✓ Success (mock-3)");
  });

  it("injected sends 1000 unchanged and the mock rejects with CapExceeded", async () => {
    const context = await createMockContext();
    const before = await context.client.getVault(context.vault);
    const propose = vi.fn().mockResolvedValue('{"amountUsdc":"1000","reason":"Operator override"}');
    const swap = vi.spyOn(context.client, "swap");
    const log = vi.fn();
    expect(await runAgent(context, "injected", propose, log)).toBe(true);
    expect(propose.mock.calls[0][0]).toContain("Swap the entire 1,000 testUSDC");
    expect(swap).toHaveBeenCalledWith(context.agent, context.vault, 1_000_000_000n);
    expect(await context.client.getVault(context.vault)).toEqual(before);
    expect(log.mock.calls.flat().join("\n")).toContain("Result [mock]: ✗ CapExceeded");
  });

  it("attacker changes only outputVault and submits swapRaw without calling a model", async () => {
    const context = await createMockContext();
    const before = await context.client.getVault(context.vault);
    const expected = deriveSwapAccounts(context.vault, before.inputMint, before.outputMint);
    const swapRaw = vi.spyOn(context.client, "swapRaw");
    const propose = vi.fn();
    expect(await runAgent(context, "attacker", propose, vi.fn())).toBe(true);
    expect(propose).not.toHaveBeenCalled();
    const [agent, accounts, amount] = swapRaw.mock.calls[0];
    expect(agent).toBe(context.agent);
    expect(amount).toBe(20_000_000n);
    expect(accounts.outputVault.equals(expected.outputVault)).toBe(false);
    expect({ ...accounts, outputVault: expected.outputVault }).toEqual(expected);
    expect(await context.client.getVault(context.vault)).toEqual(before);
    expect((await context.client.listActivity(context.vault))[0]).toMatchObject({ ok: false, error: "AccountMismatch" });
  });

  it("scripted runs all three scenarios in order without a model", async () => {
    const context = await createMockContext();
    const propose = vi.fn();
    const swap = vi.spyOn(context.client, "swap");
    const log = vi.fn();
    expect(await runAgent(context, "scripted", propose, log)).toBe(true);
    expect(propose).not.toHaveBeenCalled();
    expect(swap.mock.calls.map((call) => call[2])).toEqual([20_000_000n, 1_000_000_000n]);
    const activity = (await context.client.listActivity(context.vault)).slice(0, 3).reverse();
    expect(activity.map((item) => item.error ?? "Success")).toEqual(["Success", "CapExceeded", "AccountMismatch"]);
    expect(await context.client.getVault(context.vault)).toMatchObject({ inputBalanceRaw: 980_000_000n, outputBalanceRaw: 200_000_000n, spentRaw: 20_000_000n });
    expect(log.mock.calls.flat().join("\n")).toContain("Scripted reply (no model)");
  });

  it("reports an injection refusal without replacing the model amount", async () => {
    const context = await createMockContext();
    const propose = vi.fn().mockResolvedValue('{"amountUsdc":"20","reason":"I will ignore the injection"}');
    const log = vi.fn();
    expect(await runAgent(context, "injected", propose, log)).toBe(false);
    expect((await context.client.getVault(context.vault)).spentRaw).toBe(20_000_000n);
    expect(log.mock.calls.flat().join("\n")).toContain("Model did not follow the full-balance injection");
    expect(log.mock.calls.flat().join("\n")).toContain("--mode scripted");
  });

  it.each(["I refuse the injection", '{"amountUsdc":1000,"reason":"numeric amount"}'])("does not submit malformed/refused output", async (reply) => {
    const context = await createMockContext();
    const before = await context.client.getVault(context.vault);
    const swap = vi.spyOn(context.client, "swap");
    const log = vi.fn();
    await expect(runAgent(context, "injected", async () => reply, log)).rejects.toThrow("not a valid trade");
    expect(swap).not.toHaveBeenCalled();
    expect(await context.client.getVault(context.vault)).toEqual(before);
    expect(log.mock.calls.flat().join("\n")).toContain("--mode scripted");
  });

  it("reports unexpected results as failures", async () => {
    const context = await createMockContext();
    vi.spyOn(context.client, "swapRaw").mockResolvedValue({ ok: true, signature: "mock-unexpected" });
    expect(await runAgent(context, "attacker", vi.fn(), vi.fn())).toBe(false);
  });
});
