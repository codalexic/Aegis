import { useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { DevnetSolHint } from "../src/DevnetSolHint";

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: vi.fn(), useState: vi.fn() }));
afterEach(() => vi.resetAllMocks());

// Exercise the small component's async connection read and dismissal without a DOM dependency.
function fixture(balance: bigint | null | Error) {
  let empty = false, dismissed = false;
  const readBalance = vi.fn(async () => { if (balance instanceof Error) throw balance; return balance; });
  const render = () => {
    vi.mocked(useState).mockImplementationOnce(() => [empty, (value: boolean) => { empty = value; }])
      .mockImplementationOnce(() => [dismissed, (value: boolean) => { dismissed = value; }]);
    return DevnetSolHint({ readBalance });
  };
  return { readBalance, render };
}

it("reads once after connection, shows the zero-SOL hint and faucet, and dismisses it", async () => {
  const f = fixture(0n);
  expect(f.render()).toBeNull();
  const cleanup = vi.mocked(useEffect).mock.calls[0][0]();
  await Promise.resolve();
  const notice = f.render()!;
  const markup = renderToStaticMarkup(notice);
  expect(markup).toContain("This wallet needs a little devnet SOL for fees.");
  expect(markup).toContain('<a href="https://faucet.solana.com" target="_blank" rel="noreferrer">');
  expect(markup).toContain('aria-label="Dismiss"');
  expect(f.readBalance).toHaveBeenCalledTimes(1);
  notice.props.onDismiss();
  expect(f.render()).toBeNull();
  if (typeof cleanup === "function") cleanup();
});

it.each([1n, null, new Error("RPC unavailable")])("hides the hint for a funded or unknown balance: %s", async (balance) => {
  const f = fixture(balance);
  f.render();
  vi.mocked(useEffect).mock.calls[0][0]();
  await Promise.resolve();
  expect(f.render()).toBeNull();
});

it("ignores a balance read that finishes after disconnect", async () => {
  const f = fixture(0n);
  f.render();
  const cleanup = vi.mocked(useEffect).mock.calls[0][0]();
  if (typeof cleanup === "function") cleanup();
  await Promise.resolve();
  expect(f.render()).toBeNull();
});
