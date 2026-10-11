import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../src/App";
import { connectDashboard } from "../src/client";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: vi.fn(react.useState) };
});

const now = 1_800_000_000n;
const finishedMessage = "Start again with a funded vault.";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Number(now) * 1000);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function render(status: "revoked" | "expired" | "active", walletBalance: bigint,
  funds: "input" | "output" | "empty" = "input", environment: "localnet" | "mock" = "localnet") {
  const connection = await connectDashboard("mock");
  const created = await connection.create();
  const vault = await connection.client.getVault(created.vault!);
  vault.revoked = status === "revoked";
  // The exact boundary is expired; one second before it is still active.
  vault.expiryUnix = status === "expired" ? now : now + 1n;
  vault.inputBalanceRaw = funds === "input" ? 1_000_000_000n : 0n;
  vault.outputBalanceRaw = funds === "output" ? 200_000_000n : 0n;
  connection.environment = environment;
  connection.faucet = vi.fn();
  // Supply the state normally populated by polling, then render the real dashboard.
  vi.mocked(useState).mockImplementationOnce(() => [vault, vi.fn()])
    .mockImplementationOnce(() => [walletBalance, vi.fn()]);
  return renderToStaticMarkup(createElement(Dashboard, { connection, toolbar: null }));
}

function button(markup: string, label: string) {
  const element = markup.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
  expect(element, label).toBeDefined();
  return element!;
}

describe.each(["revoked", "expired"] as const)("%s vault", (status) => {
  it.each([0n, 1_000_000_000n])("replaces funding at wallet balance %s with a primary new-vault action", async (balance) => {
    const markup = await render(status, balance);
    expect(markup).toContain(finishedMessage);
    expect(markup).not.toContain(">Fund 1,000</button>");
    expect(markup).not.toContain(">Get 1,000 testUSDC</button>");
    expect(button(markup, "New demo vault")).toContain('class="primary"');
    expect(button(markup, "New demo vault")).not.toContain("disabled");
    for (const label of ["Run normal trade", "Inject malicious news", "Hacker redirect", "Live AI", "Scripted"]) {
      expect(button(markup, label)).toContain('disabled=""');
    }
    expect(markup).not.toContain("Pick a scenario above.");
  });

  it.each(["input", "output", "empty"] as const)("allows withdrawal only with funds: %s", async (funds) => {
    const markup = await render(status, 0n, funds);
    expect(button(markup, "Withdraw all").includes('disabled=""')).toBe(funds === "empty");
  });

  it("also disables practice trades", async () => {
    expect(button(await render(status, 0n, "input", "mock"), "Swap")).toContain('disabled=""');
  });
});

it.each([0n, 1_000_000_000n])("preserves active-vault actions at wallet balance %s", async (balance) => {
  const markup = await render("active", balance);
  expect(markup).not.toContain(finishedMessage);
  expect(button(markup, balance === 0n ? "Get 1,000 testUSDC" : "Fund 1,000")).not.toContain("disabled");
  for (const label of ["Withdraw all", "Run normal trade", "Inject malicious news", "Hacker redirect"]) {
    expect(button(markup, label)).not.toContain("disabled");
  }
  expect(markup).toContain("Pick a scenario above.");
});
