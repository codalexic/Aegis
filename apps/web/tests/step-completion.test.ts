// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Activity, VaultState } from "@aegis/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dashboard } from "../src/App";
import { connectDashboard, type DashboardConnection } from "../src/client";

let root: Root, container: HTMLDivElement, connection: DashboardConnection;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  connection = await connectDashboard("mock");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

async function mount() {
  await act(async () => root.render(createElement(Dashboard, { connection, toolbar: null })));
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button, label).toBeDefined();
  expect(button!.disabled, label).toBe(false);
  await act(async () => button!.click());
}

function expectSteps(...states: string[]) {
  const steps = [...container.querySelectorAll(".steps .step")];
  expect(steps.map((step) => step.className)).toEqual(states.map((state) => `step ${state}`));
  steps.forEach((step, index) => {
    expect(step.querySelector(".sr-only")?.textContent).toBe(states[index] === "done" ? "Done: " : undefined);
  });
}

async function loadedVault(overrides: Partial<VaultState> = {}, activity: Activity[] = []) {
  const created = await connection.create();
  connection.initialVault = created.vault!;
  const vault = { ...await connection.client.getVault(created.vault!), ...overrides };
  vi.spyOn(connection.client, "getVault").mockResolvedValue(vault);
  vi.spyOn(connection.client, "listActivity").mockResolvedValue(activity);
  return vault;
}

it("keeps funding complete after fund → withdraw without any trades", async () => {
  await mount();
  await click("Create vault");
  expectSteps("done", "next", "todo");
  await click("Fund 1,000");
  expectSteps("done", "done", "next");
  await click("Withdraw all");
  expect(container.querySelector('[data-testid="input-balance"]')?.textContent).toBe("0");
  expectSteps("done", "done", "todo");
});

it.each(["inputBalanceRaw", "spentRaw", "outputBalanceRaw"] as const)(
  "recognizes prior funding from %s without loaded activity", async (field) => {
    await loadedVault({ [field]: 1n });
    await mount();
    expectSteps("done", "done", field === "spentRaw" ? "done" : field === "inputBalanceRaw" ? "next" : "todo");
  },
);

it.each([true, false])("counts a loaded funding transaction only when successful: %s", async (ok) => {
  await loadedVault({}, [{ signature: "mock-fund", slot: 1n, ok }]);
  connection.readDetail = vi.fn(async () => ({ label: "Fund vault", amount: "1000 testUSDC" }));
  await mount();
  expectSteps("done", ok ? "done" : "next", "todo");
});

it("keeps a fresh vault pending despite a successful withdrawal or another vault's funding", async () => {
  const other = await connection.newDemo();
  expect(other.ok).toBe(true);
  await loadedVault({}, [{ signature: "mock-withdraw", slot: 1n, ok: true }]);
  connection.readDetail = vi.fn(async () => ({ label: "Withdraw", amount: "1000 testUSDC" }));
  await mount();
  expectSteps("done", "next", "todo");
});

it.each(["revoked", "expired"] as const)("preserves completed steps after trades → %s → withdraw", async (status) => {
  await mount();
  await click("Create vault");
  await click("Fund 1,000");
  const form = container.querySelector("form")!;
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expectSteps("done", "done", "done");
  if (status === "revoked") await click("Revoke agent");
  else await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
  await click("Withdraw all");
  expectSteps("done", "done", "done");
  expect(container.textContent).toContain("Start again with a funded vault.");
  const funding = container.querySelectorAll(".steps .step")[1];
  expect(funding.querySelector("button.primary")?.textContent).toBe("New demo vault");
  expect(funding.querySelector("button")?.disabled).toBe(false);
  await click("New demo vault");
  expectSteps("done", "done", "next");
});

it.each(["revoked", "expired"] as const)("retains a blocked agent request on a drained %s vault", async (status) => {
  await loadedVault({
    revoked: status === "revoked",
    ...(status === "expired" && { expiryUnix: BigInt(Math.floor(Date.now() / 1000)) }),
  }, [
    { signature: "mock-swap", slot: 2n, ok: false, error: "CapExceeded" },
    { signature: "mock-fund", slot: 1n, ok: true },
  ]);
  connection.readDetail = vi.fn(async (signature) => ({
    label: signature === "mock-swap" ? "Agent swap" : "Fund vault", amount: "1000 testUSDC",
  }));
  await mount();
  expectSteps("done", "done", "done");
});
