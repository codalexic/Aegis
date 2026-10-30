import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard, FundingStep } from "../src/App";
import { connectDashboard } from "../src/client";
import { connectWalletDashboard } from "../src/wallet-client";
import { DEMO_FUND_RAW, newFundedDemo, readWalletBalance, withWalletBalanceRefresh } from "../src/funding";
import { Notice } from "../src/Notice";
import { startDashboardPolling } from "../src/polling";
import { getAssociatedTokenAddressSync } from "../src/browser-token";
import deployment from "../../../deployments/devnet.json";
import localnet from "../../../deployments/localnet.json";
import { WalletAegisClient } from "../../../packages/sdk/src/wallet";
import { deriveVaultPda } from "../../../packages/sdk/src/addresses";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["fund", "faucet", "withdraw", "partial failure"])("keeps %s pending until the immediate balance refresh completes", async (kind) => {
  const confirmed = Promise.withResolvers<string>();
  const balance = Promise.withResolvers<void>();
  const refresh = vi.fn(() => balance.promise);
  const finished = vi.fn();
  const failure = new Error("Partial success");
  const pending = withWalletBalanceRefresh(() => confirmed.promise, refresh).then(finished, finished);
  expect(refresh).not.toHaveBeenCalled();
  if (kind === "partial failure") confirmed.reject(failure);
  else confirmed.resolve("confirmed");
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(finished).not.toHaveBeenCalled();
  balance.resolve();
  await pending;
  expect(finished).toHaveBeenCalledExactlyOnceWith(kind === "partial failure" ? failure : "confirmed");
});

it("does not turn a confirmed funding result into a failure when balance refresh is unavailable", async () => {
  await expect(withWalletBalanceRefresh(async () => "confirmed", async () => { throw new Error("network timeout"); })).resolves.toBe("confirmed");
  const original = new Error("InsufficientFunds");
  await expect(withWalletBalanceRefresh(async () => { throw original; }, async () => { throw new Error("network timeout"); })).rejects.toBe(original);
});

describe("funding action", () => {
  function render(balance: bigint | null, options: { hasFaucet?: boolean; locked?: boolean } = {}) {
    return renderToStaticMarkup(createElement(FundingStep, {
      text: "Test money only.", balance, hasFaucet: true, locked: false,
      finished: false, busy: null, onFaucet: vi.fn(), onFund: vi.fn(), onNewDemo: vi.fn(), ...options,
    }));
  }

  it.each([0n, DEMO_FUND_RAW - 1n, DEMO_FUND_RAW, 10_000_000_000n, null])("shows one action for wallet balance %s", (balance) => {
    const markup = render(balance);
    const low = balance !== null && balance < DEMO_FUND_RAW;
    expect(markup).toContain(low ? ">Get 1,000 testUSDC</button>" : ">Fund 1,000</button>");
    expect(markup).not.toContain(low ? ">Fund 1,000</button>" : ">Get 1,000 testUSDC</button>");
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain("disabled");
  });

  it.each([[0n, "0"], [999_999_999n, "999.999999"], [DEMO_FUND_RAW, "1,000"], [null, "—"]] as const)("displays wallet balance %s", (balance, label) => {
    expect(render(balance)).toContain(`Wallet: ${label} testUSDC`);
  });

  it.each([0n, DEMO_FUND_RAW, null])("locks during actions at balance %s", (balance) => {
    expect(render(balance, { locked: true })).toContain('disabled=""');
  });

  it.each([0n, 10_000_000_000n, null])("keeps Fund available without a configured faucet at balance %s", (balance) => {
    const markup = render(balance, { hasFaucet: false });
    expect(markup).toContain(">Fund 1,000</button>");
    expect(markup).not.toContain("Get 1,000 testUSDC");
    expect(markup).not.toContain("disabled");
  });

  it("lets an empty wallet create and fund a vault in one click", async () => {
    const location = { hash: "", replace(next: string) { location.hash = next; } };
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      location,
      addEventListener() {},
      removeEventListener() {},
      history: { pushState() {} },
    });
    const connection = await connectDashboard("mock");
    connection.faucet = vi.fn();
    const markup = renderToStaticMarkup(createElement(Dashboard, { connection, toolbar: null }));
    const create = markup.match(/<button class="primary[^"]*"[^>]*>(?:(?!<\/button>).)*Create my vault<\/button>/)?.[0];
    expect(create).toBeDefined();
    expect(create).not.toContain("disabled");
    expect(markup).not.toContain("Get 1,000 testUSDC");
  });
});

describe("wallet balance read", () => {
  const account = new PublicKey(deployment.ownerInput);
  const rpcUrl = deployment.rpcUrl;

  it("uses one confirmed balance request and preserves bigint precision", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ result: { value: { amount: "9007199254740993", uiAmount: 0 } } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await readWalletBalance(rpcUrl, account)).toBe(9_007_199_254_740_993n);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(rpcUrl);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ method: "getTokenAccountBalance",
      params: [account.toBase58(), { commitment: "confirmed" }] });
  });

  it("treats a missing token account as zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: -32602, message: "Invalid param: could not find account" } })));
    expect(await readWalletBalance(rpcUrl, account)).toBe(0n);
  });

  it.each(["429", "RPC busy", "network", "invalid account", "malformed balance"])("keeps %s unknown without retries", async (kind) => {
    const fetcher = vi.fn(async () => {
      if (kind === "network") throw new Error("Network unavailable");
      if (kind === "429") return new Response("Too many requests", { status: 429 });
      if (kind === "RPC busy") return Response.json({ error: { code: -32005, message: "Node is unhealthy" } });
      if (kind === "invalid account") return Response.json({ error: { code: -32602, message: "Invalid param: not a Token account" } });
      return Response.json({ result: { value: { amount: 1000 } } });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await readWalletBalance(rpcUrl, account)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shares the existing 10-second state schedule and refreshes after confirmations", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => Response.json({ result: { value: { amount: "1000000000" } } }));
    vi.stubGlobal("fetch", fetcher);
    const visibility = Object.assign(new EventTarget(), { hidden: false });
    let balance: bigint | null = null;
    const poller = startDashboardPolling({ state: async () => { balance = await readWalletBalance(rpcUrl, account); },
      activity: async () => {}, onError: vi.fn(), visibility });
    await vi.advanceTimersByTimeAsync(0);
    expect(balance).toBe(DEMO_FUND_RAW);
    fetcher.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(6);
    await poller.refresh();
    expect(fetcher).toHaveBeenCalledTimes(7);
    poller.stop();
  });
});

describe("New demo vault funding order", () => {
  async function fixture() {
    const owner = new PublicKey(deployment.owner);
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/deployment") return Response.json(deployment);
      if (input.startsWith("/api/actions/latest-vault")) return Response.json({ vault: null });
      if (input === "/api/faucet") { calls.push("faucet"); return Response.json({ signature: "confirmed-faucet" }); }
      const request = JSON.parse(init!.body as string);
      expect(request.method).toBe("getTokenAccountBalance");
      expect(request.params[0]).toBe(getAssociatedTokenAddressSync(new PublicKey(deployment.inputMint), owner).toBase58());
      calls.push("balance");
      return Response.json({ result: { value: { amount: "1000000000" } } });
    });
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(WalletAegisClient.prototype, "rpc").mockResolvedValue(1_800_000_000);
    const create = vi.spyOn(WalletAegisClient.prototype, "createVault").mockImplementation(async () => {
      calls.push("create"); return { ok: true, signature: "confirmed-create", vault: owner };
    });
    const fund = vi.spyOn(WalletAegisClient.prototype, "fundVault").mockImplementation(async () => {
      calls.push("fund"); return { ok: true, signature: "confirmed-fund" };
    });
    const connection = await connectWalletDashboard("devnet", { publicKey: owner, signTransaction: vi.fn() });
    const refresh = async () => { await connection.getWalletBalance!(); };
    return { connection, refresh, calls, fetcher, create, fund };
  }

  it("confirms faucet, refreshes balance, then creates and funds when low", async () => {
    const f = await fixture();
    const progress = vi.fn();
    expect(await newFundedDemo(f.connection, 0n, f.refresh, progress)).toMatchObject({ ok: true });
    expect(f.calls).toEqual(["faucet", "balance", "create", "fund"]);
    expect(f.fund.mock.calls[0][2]).toBe(DEMO_FUND_RAW);
    expect(progress.mock.calls.map(([stage]) => stage)).toEqual([
      "Getting testUSDC…", "Creating and funding vault…", "Creating vault · Preparing…",
      "Creating vault · Done", "Funding vault · Preparing…", "Funding vault · Done",
    ]);
  });

  it("preserves the friendly faucet limit and never creates or funds a vault", async () => {
    const f = await fixture();
    const message = "Faucet limited: wait 10 minutes after the last activity in your testUSDC account.";
    f.fetcher.mockResolvedValueOnce(Response.json({ error: message }, { status: 429 }));
    const error = await newFundedDemo(f.connection, 0n, f.refresh).catch((error: unknown) => error);
    expect(error).toEqual(new Error(message));
    expect(renderToStaticMarkup(createElement(Notice, { tone: "error", message: error }))).toContain(message);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.fund).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it.each([DEMO_FUND_RAW, 10_000_000_000n, null])("creates and funds directly at balance %s", async (balance) => {
    const f = await fixture();
    expect(await newFundedDemo(f.connection, balance, f.refresh)).toMatchObject({ ok: true });
    expect(f.calls).toEqual(["create", "fund"]);
  });

  it("keeps creating and funding if the post-faucet balance read is busy", async () => {
    const f = await fixture();
    f.connection.getWalletBalance = vi.fn().mockResolvedValue(null);
    expect(await newFundedDemo(f.connection, 0n, f.refresh)).toMatchObject({ ok: true });
    expect(f.calls).toEqual(["faucet", "create", "fund"]);
  });

  it("leaves localnet without a faucet working", async () => {
    const lastVault = deriveVaultPda(new PublicKey(localnet.owner), 0n)[0].toBase58();
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === "/api/localnet") return Response.json({ ...localnet, lastVault });
      if (input === "/api/owner/new-demo") return Response.json({ ok: true, signature: "mock-fund", vault: lastVault });
      expect(input).toBe(localnet.rpcUrl);
      expect(JSON.parse(init!.body as string)).toMatchObject({ method: "getTokenAccountBalance",
        params: [localnet.ownerInput, { commitment: "confirmed" }] });
      return Response.json({ result: { value: { amount: "10000000000" } } });
    });
    vi.stubGlobal("fetch", fetcher);
    const connection = await connectDashboard("localnet");
    expect(connection.faucet).toBeUndefined();
    expect(await connection.getWalletBalance!()).toBe(10_000_000_000n);
    const refresh = vi.fn();
    const created = await newFundedDemo(connection, 10_000_000_000n, refresh);
    expect(created.ok).toBe(true);
    expect(fetcher.mock.calls.map(([input]) => input)).toEqual(["/api/localnet", localnet.rpcUrl, "/api/owner/new-demo"]);
    expect(refresh).not.toHaveBeenCalled();
  });
});
