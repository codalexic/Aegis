// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PublicKey } from "@solana/web3.js";
import type { Activity, VaultState } from "@aegis/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Dashboard } from "../src/App";
import { connectDashboard, type DashboardConnection } from "../src/client";

let root: Root, container: HTMLDivElement, connection: DashboardConnection;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
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

it("creates and funds a vault after setup, then points to the test cases", async () => {
  await mount();
  expect(setupTitle()).toBe("Set up your demo vault");
  expect(setupAction()?.textContent).toBe("Create my vault");
  await click("Create my vault");
  await click("Create vault");
  expect(setupTitle()).toBeNull();
  expect(container.querySelector('[data-testid="input-balance"]')?.textContent).toBe("1,000");
  await click("Run the test cases");
  expect(container.querySelector('.site-links a[aria-current="page"]')?.getAttribute("href")).toBe("#/agent");
});

it("runs all three cases in mock mode and keeps each result in the list", async () => {
  await mount();
  await click("Create my vault");
  await click("Create vault");
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
  await click("Create vault");
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

it.each(["revoked", "expired"] as const)("closes the vault after a trade → %s → withdraw, and starts over after setup", async (status) => {
  await mount();
  await click("Create my vault");
  await click("Create vault");
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
  await click("Create vault");
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

async function input(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const extra = new PublicKey(new Uint8Array(32).fill(11));

it("opens setup without creating, validates accessibly, resets defaults, and cancels", async () => {
  const create = vi.spyOn(connection, "newDemo");
  await mount();
  await click("Create my vault");
  expect(create).not.toHaveBeenCalled();
  await input("setup-cap", "101");
  expect(container.querySelector('#setup-cap')?.getAttribute('aria-invalid')).toBe("true");
  expect(container.querySelector('#setup-cap')?.getAttribute('aria-describedby')).toBe("setup-cap-error");
  expect(container.querySelector('#setup-cap-error')?.textContent).toContain("Cannot exceed");
  expect([...container.querySelectorAll('button')].find((b) => b.textContent === "Create vault")?.disabled).toBe(true);
  await click("1 week");
  await click("+ Add address");
  await input("setup-address-0", extra.toBase58());
  await click("Use demo defaults");
  expect(container.querySelector<HTMLInputElement>('#setup-cap')?.value).toBe("50");
  expect(container.querySelector<HTMLInputElement>('#setup-budget')?.value).toBe("100");
  expect(new Date(container.querySelector<HTMLInputElement>('#setup-until')!.value).getTime()).toBe(Date.now() + 3_600_000);
  expect(container.querySelector('#setup-address-0')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('.vault-setup [aria-label="Close"]')!.click());
  expect(setupTitle()).toBe("Set up your demo vault");
  expect(create).not.toHaveBeenCalled();
});

it.each([["1 hour", 3600], ["6 hours", 21600], ["12 hours", 43200], ["1 day", 86400], ["1 week", 604800]] as const)("applies the %s preset", async (label, seconds) => {
  await mount(); await click("Create my vault"); await click(label);
  expect(new Date(container.querySelector<HTMLInputElement>('#setup-until')!.value).getTime()).toBe(Date.now() + seconds * 1000);
});

it("passes chosen amounts, expiry and addresses to the mock and shows its policy with copy buttons", async () => {
  const create = vi.spyOn(connection, "newDemo");
  await mount(); await click("Create my vault");
  await input("setup-cap", "12.345678"); await input("setup-budget", "234.567891"); await click("1 day");
  await click("+ Add address"); await input("setup-address-0", extra.toBase58()); await click("Create vault");
  expect(create).toHaveBeenCalledWith(expect.any(Function), { maxTradeRaw: 12_345_678n, budgetRaw: 234_567_891n,
    durationSeconds: 86400n, withdrawAddresses: [extra] });
  const created = await create.mock.results[0].value;
  expect(await connection.client.getVault(created.vault)).toMatchObject({ maxTradeRaw: 12_345_678n, budgetRaw: 234_567_891n,
    expiryUnix: BigInt(Math.floor(Date.now() / 1000)) + 86400n, inputBalanceRaw: 1_000_000_000n });
  expect(container.querySelector(`.withdraw-policy code[title="${extra.toBase58()}"]`)).not.toBeNull();
  expect(container.querySelectorAll('.withdraw-policy button')).toHaveLength(2);
  await openPage("vault"); await click("New demo vault"); await act(async () => container.querySelector<HTMLButtonElement>('.vault-setup [aria-label="Close"]')!.click());
  expect(container.querySelector('#control-title')?.textContent).toBe("Controls");
});

it.each(["wallet", "extra"])("withdraws both tokens to %s using the correct method and labels activity", async (target) => {
  const created = await connection.newDemo(undefined, { maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n,
    durationSeconds: 3600n, withdrawAddresses: [extra] });
  connection.initialVault = created.vault!;
  await connection.scenario!("normal", created.vault!);
  const legacy = vi.spyOn(connection, "withdraw"), to = vi.spyOn(connection, "withdrawTo");
  await mount(); await openPage("vault"); await click("Withdraw all");
  const select = container.querySelector<HTMLButtonElement>('#withdraw-destination')!;
  expect(select.textContent).toBe("Your wallet");
  await act(async () => select.click());
  const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  expect(options.map((o) => o.dataset.value)).toEqual([connection.owner.toBase58(), extra.toBase58()]);
  expect(legacy).not.toHaveBeenCalled(); expect(to).not.toHaveBeenCalled();
  await act(async () => options[target === "extra" ? 1 : 0].click());
  await click("Confirm withdrawal");
  expect(target === "wallet" ? legacy : to).toHaveBeenCalledTimes(2);
  expect(target === "wallet" ? to : legacy).not.toHaveBeenCalled();
  if (target === "extra") expect(to.mock.calls.every((call) => call[2].equals(extra))).toBe(true);
  await openPage("activity");
  expect(container.textContent).toContain(`to ${target === "wallet" ? "your wallet" : `${extra.toBase58().slice(0, 4)}…${extra.toBase58().slice(-4)}`}`);
});

it("shows wallet-only policy and withdraws immediately without a chooser", async () => {
  const created = await connection.newDemo(); connection.initialVault = created.vault!;
  const withdraw = vi.spyOn(connection, "withdraw");
  await mount(); await openPage("vault");
  expect(container.querySelector('.withdraw-policy')?.textContent).toContain("Only your wallet");
  await click("Withdraw all");
  expect(withdraw).toHaveBeenCalledTimes(1);
  expect(container.querySelector('#withdraw-destination')).toBeNull();
});
