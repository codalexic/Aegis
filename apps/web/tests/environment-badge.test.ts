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

it.each(["mock", "localnet", "devnet"] as const)("shows no environment badge or footer on any %s page", async (environment) => {
  const expectNoBadge = () => {
    expect(container.querySelector("footer:not(.lp-foot)")).toBeNull();
    expect(container.querySelector(".environment")).toBeNull();
    expect(container.textContent).not.toContain("Test money, no real value");
  };

  // Disconnected start page, then every dashboard page.
  await act(async () => root.render(createElement(WalletProvider, null,
    createElement(App, { environment, walletMode: true }))));
  expect(container.querySelector(".landing")).not.toBeNull();
  expectNoBadge();

  const { connectDashboard: connectMock } = await vi.importActual<typeof import("../src/client")>("../src/client");
  const connection = await connectMock("mock");
  connection.environment = environment;
  vi.mocked(connectDashboard).mockResolvedValue(connection);
  await act(async () => root.render(createElement(WalletProvider, null,
    createElement(App, { environment, walletMode: false }))));

  for (const page of ["overview", "agent", "analytics", "activity", "vault"]) {
    await act(async () => {
      window.location.hash = `#/${page}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector('.site-links a[aria-current="page"]')?.getAttribute("href")).toBe(`#/${page}`);
    expectNoBadge();
  }
});
