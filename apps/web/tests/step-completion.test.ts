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
  window.location.hash = "#/vault";
  connection = await connectDashboard("mock");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

async function goPage(id: "vault" | "agent") {
  await act(async () => {
    window.location.hash = `#/${id}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

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

it("offers Create vault without a vault and replaces it with a checked status after creation", async () => {
  await mount();
  let setup = container.querySelector(".steps .step")!;
  expect(setup.querySelector("button")?.textContent).toBe("Create vault");
  expect(setup.querySelector("button")?.disabled).toBe(false);
  await click("Create vault");
  expectSteps("done", "next", "todo");
  setup = container.querySelector(".steps .step")!;
  expect(setup.querySelector("button")).toBeNull();
  expect(setup.querySelector(".step-num svg")).not.toBeNull();
  expect(setup.textContent).toBe("Done: Vault createdGuardrails set.");
});

it("shows a checked status without Create vault for a returning wallet", async () => {
  await loadedVault();
  await mount();
  expectSteps("done", "next", "todo");
  const setup = container.querySelector(".steps .step")!;
  expect(setup.querySelector("button")).toBeNull();
  expect(setup.querySelector(".step-num svg")).not.toBeNull();
  expect(setup.textContent).toBe("Done: Vault createdGuardrails set.");
});

it.each([0n, 1_000_000_000n])("keeps completed funding actionable with wallet balance %s", async (balance) => {
  await loadedVault({ inputBalanceRaw: 1_000_000_000n });
  connection.getWalletBalance = vi.fn(async () => balance);
  connection.faucet = vi.fn(async () => "TestUSDC received.");
  const fund = vi.spyOn(connection, "fund");
  await mount();
  expectSteps("done", "done", "next");
  const label = balance === 0n ? "Get 1,000 testUSDC" : "Fund 1,000";
  expect(container.querySelectorAll(".steps .step")[1].querySelector("button")?.textContent).toBe(label);
  await click(label);
  expect(balance === 0n ? connection.faucet : fund).toHaveBeenCalledTimes(1);
});

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
  await goPage("agent");
  const form = container.querySelector("form")!;
  expect(form).toBeTruthy();
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await goPage("vault");
  expectSteps("done", "done", "done");
  if (status === "revoked") await click("Revoke agent");
  else await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
  await click("Withdraw all");
  expectSteps("done", "done", "done");
  expect(container.textContent).toContain("Start again with a funded vault.");
  const funding = container.querySelector(".setup-next")!;
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

function setupPanel() {
  return container.querySelector(".go-live")!;
}

function expectNoEmptyStepBodies() {
  for (const step of setupPanel().querySelectorAll(".step")) {
    expect(step.querySelector("strong")?.textContent?.trim()).toBeTruthy();
    expect(step.querySelector("p")?.textContent?.trim()).toBeTruthy();
    for (const body of step.querySelectorAll("div, p")) {
      expect(body.textContent?.trim()).toBeTruthy();
    }
  }
  expect(setupPanel().querySelector(".step-action:empty")).toBeNull();
}

it.each([0n, 1_000_000_000n])("prominently offers funding for an empty vault at wallet balance %s", async (balance) => {
  await loadedVault();
  connection.getWalletBalance = vi.fn(async () => balance);
  connection.faucet = vi.fn(async () => "TestUSDC received.");
  await mount();
  expectNoEmptyStepBodies();
  expect(setupPanel().querySelector(".step.next button.primary")?.textContent)
    .toBe(balance === 0n ? "Get 1,000 testUSDC" : "Fund 1,000");
});

it("offers the agent and owner controls in a funded vault without empty step bodies", async () => {
  await loadedVault({ inputBalanceRaw: 1_000_000_000n });
  await mount();
  expectNoEmptyStepBodies();
  expect(setupPanel().querySelector(".step.next button.primary")?.textContent).toBe("Go to agent ");
  const controls = setupPanel().querySelector(".owner-panel")!;
  expect(controls.textContent).toContain("Revoke agent");
  expect(controls.textContent).toContain("Withdraw all");
  await click("Go to agent ");
  expect(window.location.hash).toBe("#/agent");
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(container.querySelector("#trade-title")?.textContent).toBe("Try an agent trade");
});

it.each([0n, 980_000_000n])("renders the all-done summary and the next action with input balance %s", async (inputBalanceRaw) => {
  await loadedVault({ inputBalanceRaw, spentRaw: 20_000_000n });
  await mount();
  const panel = setupPanel();
  const summary = panel.querySelector('[aria-label="Setup complete"]')!;
  expect(summary.classList.contains("steps--complete")).toBe(true);
  expect(summary.querySelectorAll(".step.done .step-num svg")).toHaveLength(3);
  expect(summary.querySelector("button")).toBeNull();
  expect(panel.querySelector("h2")?.textContent).toBe("Vault ready");
  expect(panel.querySelector('[data-testid="vault-status"]')?.textContent).toBe("Active");
  expect(panel.querySelector(".setup-next button.primary")?.textContent)
    .toBe(inputBalanceRaw === 0n ? "Fund 1,000" : "Go to agent ");
  expectNoEmptyStepBodies();
});

it("keeps refilling prominent after funding then withdrawing before an agent request", async () => {
  await mount();
  await click("Create vault");
  await click("Fund 1,000");
  await click("Withdraw all");
  expect(setupPanel().querySelector(".step.done button.primary")?.textContent).toBe("Fund 1,000");
  expectNoEmptyStepBodies();
});

it.each(["revoked", "expired"] as const)("offers a new demo for a finished %s vault before any funding", async (status) => {
  await loadedVault({ revoked: status === "revoked",
    ...(status === "expired" && { expiryUnix: BigInt(Math.floor(Date.now() / 1000)) }),
  });
  await mount();
  expect(setupPanel().textContent).toContain("Start again with a funded vault.");
  expect(setupPanel().querySelector("button.primary")?.textContent).toBe("New demo vault");
  expect(setupPanel().textContent).not.toContain("Go to agent");
  expectNoEmptyStepBodies();
});
