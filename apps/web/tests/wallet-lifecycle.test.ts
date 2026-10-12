// @vitest-environment happy-dom
import { EventEmitter } from "node:events";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Activity, VaultState } from "@aegis/sdk";
import { WalletAegisClient } from "../../../packages/sdk/src/wallet";
import deployment from "../../../deployments/devnet.json";
import { App } from "../src/App";
import { WalletProvider } from "../src/WalletProvider";
import { useWallet } from "../src/wallet-react";
import { isWalletDisconnected, WALLET_CHANGED, WALLET_REQUEST_FAILED } from "../src/wallet-lifecycle";

const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const A = new PublicKey(deployment.owner), B = new PublicKey(deployment.agent), vaultA = key(3), vaultB = key(4);
const vault = (owner: PublicKey): VaultState => ({
  address: owner.equals(A) ? vaultA : vaultB, owner, agent: new PublicKey(deployment.agent),
  inputMint: new PublicKey(deployment.inputMint), outputMint: new PublicKey(deployment.outputMint),
  maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, spentRaw: 0n,
  expiryUnix: BigInt(Math.floor(Date.now() / 1000)) + 3600n, revoked: false,
  inputBalanceRaw: owner.equals(A) ? 111_000_000n : 222_000_000n, outputBalanceRaw: 0n,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const disconnected = (name = "WalletDisconnectedError") => Object.assign(new Error(), { name });

// Drive the real pinned adapter and WalletProviderBase with Phantom's event API.
// This also catches adapter-specific null-key errors that a mock hook would miss.
class MockPhantom extends EventEmitter {
  isPhantom = true;
  isConnected = false;
  publicKey: PublicKey | null = A;
  connect = vi.fn(async () => { this.isConnected = true; });
  disconnect = vi.fn(async () => { this.isConnected = false; this.emit("disconnect"); });
  signTransaction = vi.fn(async (transaction: unknown) => transaction);
  switchAccount(publicKey: PublicKey | null) {
    this.publicKey = publicKey;
    this.emit("accountChanged", publicKey);
  }
  disconnectExternally() {
    this.isConnected = false;
    this.publicKey = null;
    this.emit("disconnect");
  }
}

let root: Root, container: HTMLDivElement, phantom: MockPhantom;
let context: ReturnType<typeof useWallet>;
let reads: ReturnType<typeof vi.spyOn<WalletAegisClient, "getVault">>;
let history: ReturnType<typeof vi.spyOn<WalletAegisClient, "listActivity">>;
let latest: (owner: string) => Promise<Response>;
let balance: () => Promise<Response>;
let requests: { url: string; signal?: AbortSignal | null }[];

function Capture() { context = useWallet(); return null; }
async function flush(action: () => void = () => {}) {
  await act(async () => { action(); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button, `${label}: ${container.textContent}`).toBeDefined();
  await flush(() => button!.click());
}
const ownerVisible = (owner: PublicKey) => container.querySelector(`[aria-label="Owner ${owner.toBase58()}"]`);
const alerts = () => container.querySelectorAll('[role="alert"]');
async function mount() {
  await flush(() => root.render(createElement(StrictMode, null,
    createElement(WalletProvider, null, createElement(Capture), createElement(App, { environment: "devnet", walletMode: true })))));
}
async function connect() {
  await mount();
  expect(context.wallet?.readyState).toBe("Installed");
  await click("Connect wallet");
  expect(context.connected).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  phantom = new MockPhantom();
  Object.defineProperty(window, "isPhantomInstalled", { configurable: true, value: true });
  Object.defineProperty(window, "phantom", { configurable: true, value: { solana: phantom } });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  reads = vi.spyOn(WalletAegisClient.prototype, "getVault").mockImplementation(async (address) => vault(address.equals(vaultA) ? A : B));
  history = vi.spyOn(WalletAegisClient.prototype, "listActivity").mockResolvedValue([]);
  vi.spyOn(WalletAegisClient.prototype, "rpc").mockResolvedValue({ value: 1_000_000_000 });
  latest = async (owner) => Response.json({ vault: owner === A.toBase58() ? vaultA.toBase58() : vaultB.toBase58() });
  balance = async () => Response.json({ result: { value: { amount: "1000000000" } } });
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    requests.push({ url, signal: options?.signal });
    if (url === "/api/deployment") return Response.json(deployment);
    if (url.startsWith("/api/actions/latest-vault")) return latest(new URL(url, "http://localhost").searchParams.get("account")!);
    if (url === "/api/agent/info") return Response.json({});
    if (url.startsWith("https://")) return balance();
    throw new Error(`Unexpected request: ${url}`);
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await flush(() => root.unmount());
  expect(phantom.listenerCount("accountChanged")).toBeLessThanOrEqual(1); // Only the adapter's own listener may remain.
  container.remove();
  Reflect.deleteProperty(window, "phantom");
  Reflect.deleteProperty(window, "isPhantomInstalled");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});

it("switches A → B, clears A immediately, and drops A's late vault discovery", async () => {
  const old = deferred<Response>();
  latest = async (owner) => owner === A.toBase58() ? old.promise : Response.json({ vault: vaultB.toBase58() });
  await connect();
  const oldRequest = requests.find(({ url }) => url.includes(A.toBase58()))!;
  await flush(() => phantom.switchAccount(B));
  expect(ownerVisible(B)).not.toBeNull();
  expect(ownerVisible(A)).toBeNull();
  expect(oldRequest.signal?.aborted).toBe(true);
  await flush(() => old.resolve(Response.json({ vault: vaultA.toBase58() })));
  expect(ownerVisible(B)).not.toBeNull();
  expect(reads.mock.calls.map(([address]) => address.toBase58())).not.toContain(vaultA.toBase58());
  expect(container.textContent).toContain("222");
  expect(alerts()).toHaveLength(0);
});

it.each(["vault", "activity", "balance", "failure"])("drops an old owner's late %s poll and stops its polling", async (kind) => {
  await connect();
  expect(ownerVisible(A)).not.toBeNull();
  const oldState = deferred<VaultState>(), oldHistory = deferred<Activity[]>(), oldBalance = deferred<Response>();
  if (kind === "activity") history.mockReturnValueOnce(oldHistory.promise);
  else if (kind === "balance") balance = () => oldBalance.promise;
  else reads.mockReturnValueOnce(oldState.promise);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  const aReads = reads.mock.calls.filter(([address]) => address.equals(vaultA)).length;
  const bDiscovery = deferred<Response>();
  latest = () => bDiscovery.promise;
  await flush(() => phantom.switchAccount(B));
  expect(ownerVisible(A)).toBeNull();
  expect(container.textContent).not.toContain("111");
  expect(container.textContent).toContain("Connecting to the vault");
  balance = async () => Response.json({ result: { value: { amount: "2000000000" } } });
  await flush(() => bDiscovery.resolve(Response.json({ vault: vaultB.toBase58() })));
  expect(ownerVisible(B)).not.toBeNull();
  await flush(() => {
    if (kind === "failure") oldState.reject(disconnected());
    else oldState.resolve(vault(A));
    oldHistory.resolve([{ signature: "old-owner-activity", slot: 1n, ok: false, error: "CapExceeded" }]);
    oldBalance.resolve(Response.json({ result: { value: { amount: "999000000" } } }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(reads.mock.calls.filter(([address]) => address.equals(vaultA))).toHaveLength(aReads);
  expect(ownerVisible(A)).toBeNull();
  expect(container.textContent).not.toContain("old-owner-activity");
  expect(container.textContent).not.toContain("999");
  expect(container.textContent).toContain("222");
  expect(alerts()).toHaveLength(0);
});

it.each(["null account", "external disconnect", "button"])("shows a neutral connect state after %s", async (kind) => {
  await connect();
  const pending = deferred<VaultState>();
  reads.mockReturnValueOnce(pending.promise);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  if (kind === "button") await click("Disconnect");
  else await flush(() => kind === "null account" ? phantom.switchAccount(null) : phantom.disconnectExternally());
  await flush(() => pending.reject(disconnected()));
  expect(container.textContent).toContain(WALLET_CHANGED);
  expect(container.textContent).toContain("Connect wallet");
  expect(ownerVisible(A)).toBeNull();
  expect(alerts()).toHaveLength(0);
  await flush(() => context.wallet!.adapter.emit("error", disconnected("WalletNotConnectedError")));
  expect(alerts()).toHaveLength(0);
});

it("keeps cancelled connect visible, but ignores unrequested background errors", async () => {
  await mount();
  await flush(() => context.wallet!.adapter.emit("error", Object.assign(new Error("User rejected"), { code: 4001 })));
  expect(alerts()).toHaveLength(0);
  phantom.connect.mockRejectedValueOnce(Object.assign(new Error("User rejected"), { code: 4001 }));
  await click("Connect wallet");
  expect(container.textContent).toContain(WALLET_REQUEST_FAILED);
  expect(alerts()).toHaveLength(1);
  await click("Connect wallet");
  expect(ownerVisible(A)).not.toBeNull();
  expect(alerts()).toHaveLength(0);
});

it.each(["WalletDisconnectedError", "WalletNotConnectedError"])("ignores background %s while still mounted", async (name) => {
  reads.mockRejectedValueOnce(disconnected(name));
  await connect();
  expect(alerts()).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(container.textContent).toContain("111");
});

it("invalidates an A session even when A → B → A events are batched", async () => {
  const old = deferred<Response>();
  latest = () => old.promise;
  await connect();
  const oldRequest = requests.find(({ url }) => url.includes(A.toBase58()))!;
  latest = async () => Response.json({ vault: null });
  await flush(() => { phantom.switchAccount(B); phantom.switchAccount(A); });
  expect(ownerVisible(A)).not.toBeNull();
  expect(oldRequest.signal?.aborted).toBe(true);
  await flush(() => old.resolve(Response.json({ vault: vaultA.toBase58() })));
  expect(reads).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("111");
});

it.each(["resolve", "reject"])("reports explicit sign rejection, but drops a stale sign that will %s", async (outcome) => {
  const submitted = vi.fn();
  vi.spyOn(WalletAegisClient.prototype, "revoke").mockImplementation(async (wallet) => {
    await wallet.signTransaction({} as never);
    submitted();
    return { ok: true, signature: "test-signature" };
  });
  await connect();
  phantom.signTransaction.mockRejectedValueOnce(new Error("User rejected the request"));
  await click("Revoke agent");
  expect(container.textContent).toContain(WALLET_REQUEST_FAILED);
  const late = deferred<unknown>();
  phantom.signTransaction.mockReturnValueOnce(late.promise);
  await click("Revoke agent");
  await flush(() => phantom.switchAccount(B));
  await flush(() => outcome === "resolve" ? late.resolve({}) : late.reject(new Error("User rejected the request")));
  expect(ownerVisible(B)).not.toBeNull();
  expect(submitted).not.toHaveBeenCalled();
  expect(alerts()).toHaveLength(0);
});

it("drops a connect failure after the adapter has disconnected", async () => {
  const pending = deferred<void>();
  phantom.connect.mockReturnValueOnce(pending.promise);
  await mount();
  await click("Connect wallet");
  await flush(() => context.wallet!.adapter.emit("disconnect"));
  await flush(() => pending.reject(new Error("Connection interrupted")));
  expect(container.textContent).toContain(WALLET_CHANGED);
  expect(alerts()).toHaveLength(0);
});

it("shows connection progress, then the logo loader while discovering the wallet's vault", async () => {
  const connecting = deferred<void>();
  const discovery = deferred<Response>();
  phantom.connect.mockReturnValueOnce(connecting.promise);
  latest = () => discovery.promise;
  await mount();
  await click("Connect wallet");
  const button = container.querySelector('button[aria-label="Connecting…"]');
  expect(button?.getAttribute("aria-busy")).toBe("true");
  expect(button?.querySelector(".progress-spinner")).not.toBeNull();
  expect(container.textContent).toContain("Approve connection in Phantom…");
  await flush(() => connecting.resolve());
  expect(container.querySelector('[data-testid="connecting-logo"]')).not.toBeNull();
  expect(container.querySelector(".connecting-mark")).not.toBeNull();
  expect(container.querySelector('[data-testid="vault-skeleton"]')).toBeNull();
  await flush(() => discovery.resolve(Response.json({ vault: vaultA.toBase58() })));
  expect(container.querySelector('[data-testid="connecting-logo"]')).toBeNull();
  expect(ownerVisible(A)).not.toBeNull();
});

it("recognizes wrapped disconnects without swallowing a real user cancellation", () => {
  expect(isWalletDisconnected({ error: disconnected("WalletNotConnectedError") })).toBe(true);
  expect(isWalletDisconnected({ cause: disconnected() })).toBe(true);
  expect(isWalletDisconnected({ code: 4001 })).toBe(false);
});
