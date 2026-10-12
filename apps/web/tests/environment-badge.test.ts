// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { connectDashboard } from "../src/client";
import { WalletProvider } from "../src/WalletProvider";

vi.mock("../src/client", async (importOriginal) => {
  const client = await importOriginal<typeof import("../src/client")>();
  return { ...client, connectDashboard: vi.fn(client.connectDashboard) };
});

let root: Root, container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  window.history.replaceState(null, "", "/");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["mock", "Practice", "Practice (mock)"],
  ["localnet", "Localnet", "Solana localnet"],
  ["devnet", "Devnet", "Solana devnet"],
] as const)("keeps the %s disclaimer on the badge with no footer on any page", async (environment, label, title) => {
  const disclaimer = `${title} · Test money, no real value`;
  const expectDisclaimer = () => {
    expect(container.querySelector("footer")).toBeNull();
    expect(container.textContent).not.toContain("Test money, no real value");
    const badge = container.querySelector(".start-bar .environment, .content-top .environment");
    expect(badge?.textContent).toBe(label);
    expect(badge?.getAttribute("title")).toBe(disclaimer);
    expect(badge?.getAttribute("aria-label")).toBe(disclaimer);
  };

  // Disconnected start page, then the same header badge on every dashboard route.
  await act(async () => root.render(createElement(WalletProvider, null,
    createElement(App, { environment, walletMode: true }))));
  expect(container.querySelector(".shell--start")).not.toBeNull();
  expectDisclaimer();

  const { connectDashboard: connectMock } = await vi.importActual<typeof import("../src/client")>("../src/client");
  const connection = await connectMock("mock");
  connection.environment = environment;
  vi.mocked(connectDashboard).mockResolvedValue(connection);
  await act(async () => root.render(createElement(WalletProvider, null,
    createElement(App, { environment, walletMode: false }))));

  for (const page of ["vault", "agent", "stats", "activity"]) {
    await act(async () => {
      window.location.hash = `#/${page}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector('.nav a[aria-current="true"]')?.getAttribute("href")).toBe(`#/${page}`);
    expectDisclaimer();
  }
});
