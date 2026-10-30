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
  window.location.hash = "#/overview";
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

/** Opens a dashboard page by its hash route, as the header links do. */
async function openPage(page: "overview" | "agent" | "analytics" | "activity" | "vault") {
  await act(async () => {
    window.location.hash = `#/${page}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

/** The Overview setup card's headline, or null once the AI can trade. */
const setupTitle = () => container.querySelector("#setup-title")?.textContent ?? null;
const setupAction = () => container.querySelector<HTMLButtonElement>(".setup-card button.primary");
/** A KPI's settled value (the visible digits count up; screen readers get the final number). */
const kpi = (tone: string) => container.querySelector(`.kpi.${tone} strong .sr-only`)?.textContent;

async function loadedVault(overrides: Partial<VaultState> = {}, activity: Activity[] = []) {
  const created = await connection.create();
  connection.initialVault = created.vault!;
  const vault = { ...await connection.client.getVault(created.vault!), ...overrides };
  vi.spyOn(connection.client, "getVault").mockResolvedValue(vault);
  vi.spyOn(connection.client, "listActivity").mockResolvedValue(activity);
  return vault;
}

it("creates and funds a vault in one click, then points to the test cases", async () => {
  await mount();
  expect(setupTitle()).toBe("Set up your demo vault");
  expect(setupAction()?.textContent).toBe("Create my vault");
  await click("Create my vault");
  expect(setupTitle()).toBeNull();
  expect(container.querySelector('[data-testid="input-balance"]')?.textContent).toBe("1,000");
  await click("Run the test cases");
  expect(container.querySelector('.site-links a[aria-current="page"]')?.getAttribute("href")).toBe("#/agent");
});

it("runs all three cases in mock mode and keeps each result in the list", async () => {
  await mount();
  await click("Create my vault");
  await openPage("agent");
  await click("Run normal trade");
  await click("Inject malicious news");
  await click("Hacker redirect");
  const badges = [...container.querySelectorAll(".scenario-last .badge")].map((badge) => badge.textContent);
  expect(badges).toEqual(["Allowed", "Blocked", "Blocked"]);
  expect(container.querySelector('[data-testid="agent-outcome"] strong')?.textContent).toBe("Blocked by Aegis · Wrong destination");
  await openPage("analytics");
  expect([kpi("is-ok"), kpi("is-bad"), kpi("is-pink")]).toEqual(["1", "2", "1,030"]);
});

it("keeps the cases locked until there is money to trade", async () => {
  await loadedVault();
  await mount();
  expect(setupTitle()).toBe("Add test money");
  await openPage("agent");
  expect(container.textContent).toContain("Set up and fund your vault before running the cases.");
  expect([...container.querySelectorAll<HTMLButtonElement>(".scenario button")].every((button) => button.disabled)).toBe(true);
});

it.each([0n, 1_000_000_000n])("offers the right funding action at wallet balance %s", async (balance) => {
  await loadedVault();
  connection.getWalletBalance = vi.fn(async () => balance);
  connection.faucet = vi.fn(async () => "TestUSDC received.");
  const fund = vi.spyOn(connection, "fund");
  await mount();
  const label = balance === 0n ? "Get 1,000 testUSDC" : "Fund 1,000";
  expect(setupAction()?.textContent).toBe(label);
  await click(label);
  expect(balance === 0n ? connection.faucet : fund).toHaveBeenCalledTimes(1);
});

it("asks for a top-up after fund → withdraw without any trades", async () => {
  await mount();
  await click("Create my vault");
  await openPage("vault");
  await click("Withdraw all");
  await openPage("overview");
  expect(setupTitle()).toBe("Top up your vault");
  await click("Fund 1,000");
  expect(setupTitle()).toBe(null);
});

it.each([["inputBalanceRaw", null], ["spentRaw", "Top up your vault"], ["outputBalanceRaw", "Top up your vault"]] as const)(
  "recognizes prior funding from %s without loaded activity", async (field, expected) => {
    await loadedVault({ [field]: 1n });
    await mount();
    expect(setupTitle()).toBe(expected);
  },
);

it.each([true, false])("counts a loaded funding transaction only when successful: %s", async (ok) => {
  await loadedVault({}, [{ signature: "mock-fund", slot: 1n, ok }]);
  connection.readDetail = vi.fn(async () => ({ label: "Fund vault", amount: "1000 testUSDC" }));
  await mount();
  expect(setupTitle()).toBe(ok ? "Top up your vault" : "Add test money");
});

it("keeps a fresh vault unfunded despite a successful withdrawal or another vault's funding", async () => {
  const other = await connection.newDemo();
  expect(other.ok).toBe(true);
  await loadedVault({}, [{ signature: "mock-withdraw", slot: 1n, ok: true }]);
  connection.readDetail = vi.fn(async () => ({ label: "Withdraw", amount: "1000 testUSDC" }));
  await mount();
  expect(setupTitle()).toBe("Add test money");
});

it.each(["revoked", "expired"] as const)("closes the vault after a trade → %s → withdraw, and starts over in one click", async (status) => {
  await mount();
  await click("Create my vault");
  await openPage("agent");
  await click("Run normal trade");
  await openPage("analytics");
  expect(kpi("is-ok")).toBe("1");
  await openPage("vault");
  if (status === "revoked") await click("Revoke agent");
  else await act(async () => { await vi.advanceTimersByTimeAsync(3_600_000); });
  await click("Withdraw all");
  await openPage("overview");
  expect(setupTitle()).toBe("This vault is closed");
  expect(container.querySelector(".next-hint")).toBeNull();
  await click("New demo vault");
  expect(setupTitle()).toBe(null);
});

it.each(["revoked", "expired"] as const)("keeps a blocked agent request in the results of a drained %s vault", async (status) => {
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
  expect(setupTitle()).toBe("This vault is closed");
  await openPage("analytics");
  expect(kpi("is-bad")).toBe("1");
  expect(kpi("is-pink")).toBe("1,000");
  await openPage("activity");
  expect(container.textContent).toContain("Blocked · Over the per-trade cap");
});
