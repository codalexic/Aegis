// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VaultState } from "@aegis/sdk";
import { encode } from "@coral-xyz/anchor/dist/esm/utils/bytes/bs58.js";
import { WalletAegisClient } from "../../../packages/sdk/src/wallet";
import deployment from "../../../deployments/localnet.json";
import { Dashboard } from "../src/App";
import { AgentConsole } from "../src/AgentConsole";
import { connectWalletDashboard } from "../src/wallet-client";

const owner = Keypair.generate();
const vault: VaultState = {
  address: new PublicKey(deployment.pool), owner: owner.publicKey, agent: new PublicKey(deployment.agent),
  inputMint: new PublicKey(deployment.inputMint), outputMint: new PublicKey(deployment.outputMint),
  maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, spentRaw: 0n,
  expiryUnix: 1_900_003_600n, revoked: false, inputBalanceRaw: 1_000_000_000n, outputBalanceRaw: 0n,
};
let root: Root, container: HTMLDivElement;
const flush = async (action: () => void = () => {}) => { await act(async () => { action(); }); };
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === label);
  expect(found, label).toBeDefined();
  return found!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_900_000_000_000);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  window.location.hash = "#/vault";
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await flush(() => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

async function walletFixture() {
  const simulation = Promise.withResolvers<unknown>();
  const signature = Promise.withResolvers<VersionedTransaction>();
  const confirmation = Promise.withResolvers<unknown>();
  const sign = vi.fn(async (_transaction: VersionedTransaction) => signature.promise);
  const methods: string[] = [];
  vi.spyOn(WalletAegisClient.prototype, "rpc").mockImplementation(async (method, params) => {
    methods.push(method);
    if (method === "getLatestBlockhash") return { value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 } };
    if (method === "simulateTransaction") return simulation.promise;
    if (method === "sendTransaction") return encode(VersionedTransaction.deserialize(Buffer.from(params[0] as string, "base64")).signatures[0]);
    if (method === "getSignatureStatuses") return confirmation.promise;
    throw new Error(`Unexpected RPC ${method}`);
  });
  vi.spyOn(WalletAegisClient.prototype, "listActivity").mockResolvedValue([]);
  const reads = vi.spyOn(WalletAegisClient.prototype, "getVault").mockResolvedValue(vault);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/deployment") return Response.json(deployment);
    if (url.startsWith("/api/actions/latest-vault")) return Response.json({ vault: vault.address.toBase58() });
    if (url === "/api/agent/info") return Response.json({});
    return Response.json({ result: { value: { amount: "1000000000" } } });
  }));
  const connection = await connectWalletDashboard("localnet", { publicKey: owner.publicKey, signTransaction: sign });
  return { connection, reads, simulation, signature, confirmation, sign, methods };
}

it("keeps a wallet action busy through real prepare, approve, confirm and refresh stages", async () => {
  const f = await walletFixture();
  const lock = vi.fn();
  await flush(() => root.render(createElement(Dashboard, { connection: f.connection, toolbar: null, onBusyChange: lock })));
  await flush(() => button("Revoke agent").click());
  const action = button("Revoking…");
  expect(action.disabled).toBe(true);
  expect(action.getAttribute("aria-busy")).toBe("true");
  expect(action.querySelector(".progress-spinner")).not.toBeNull();
  expect(action.style.width).toBe("160px");
  expect(container.textContent).toContain("Preparing…");
  expect(f.sign).not.toHaveBeenCalled();
  for (const label of ["Create vault", "Fund 1,000", "New demo vault", "Withdraw all"]) {
    expect(button(label).disabled, label).toBe(true);
  }
  await flush(() => { window.location.hash = "#/agent"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  for (const label of ["Run normal trade", "Inject malicious news", "Hacker redirect"]) {
    expect(button(label).disabled, label).toBe(true);
  }
  await flush(() => { window.location.hash = "#/vault"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
  expect(lock).toHaveBeenLastCalledWith(true);
  await flush(() => f.simulation.resolve({ value: { err: null } }));
  expect(container.querySelector('[data-testid="toast-stack"] [role="status"]')?.textContent).toContain("Approve in Phantom…");
  expect(f.methods).not.toContain("sendTransaction");
  const signed = VersionedTransaction.deserialize(f.sign.mock.calls[0][0].serialize()); signed.sign([owner]);
  await flush(() => f.signature.resolve(signed));
  expect(container.textContent).toContain("Confirming on Solana…");
  expect(action.style.width).toBe("160px");
  expect(action.getAttribute("aria-busy")).toBe("true");
  const refresh = Promise.withResolvers<VaultState>();
  f.reads.mockReturnValueOnce(refresh.promise);
  await flush(() => f.confirmation.resolve({ value: [{ err: null, confirmationStatus: "confirmed" }] }));
  expect(container.textContent).toContain("Refreshing vault…");
  expect(action.getAttribute("aria-busy")).toBe("true");
  expect(container.querySelector('[data-testid="vault-skeleton"]')).toBeNull();
  await flush(() => refresh.resolve({ ...vault, revoked: true }));
  expect(container.textContent).toContain("Agent revoked. You can still withdraw your funds.");
  expect(container.querySelector('[data-busy="true"]')).toBeNull();
  expect(lock).toHaveBeenLastCalledWith(false);
  expect(f.methods).toEqual(["getLatestBlockhash", "simulateTransaction", "sendTransaction", "getSignatureStatuses"]);
});

it("clears progress and unlocks actions after Phantom rejects signing", async () => {
  const f = await walletFixture();
  await flush(() => root.render(createElement(Dashboard, { connection: f.connection, toolbar: null })));
  await flush(() => button("Revoke agent").click());
  await flush(() => f.simulation.resolve({ value: { err: null } }));
  await flush(() => f.signature.reject(Object.assign(new Error("User rejected"), { code: 4001 })));
  expect(container.querySelector('[data-busy="true"]')).toBeNull();
  expect(button("Revoke agent").disabled).toBe(false);
  expect(f.methods).not.toContain("sendTransaction");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('.notice.info[role="status"]')?.textContent).toContain("Connection cancelled in Phantom.");
});

it("shows stat and vault skeletons before the first load and keeps values visible during polling", async () => {
  const f = await walletFixture();
  const first = Promise.withResolvers<VaultState>();
  f.reads.mockReturnValueOnce(first.promise);
  await flush(() => root.render(createElement(Dashboard, { connection: f.connection, toolbar: null })));
  expect(container.querySelector('#overview[aria-busy="true"]')).not.toBeNull();
  expect(container.querySelectorAll(".tile .skeleton-value")).toHaveLength(4);
  expect(container.querySelector('[data-testid="vault-skeleton"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="input-balance"]')).toBeNull();
  await flush(() => first.resolve(vault));
  expect(container.querySelectorAll(".skeleton")).toHaveLength(0);
  expect(container.querySelector('[data-testid="input-balance"]')?.textContent).toBe("1,000");
  const poll = Promise.withResolvers<VaultState>(); f.reads.mockReturnValueOnce(poll.promise);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(container.querySelectorAll(".skeleton")).toHaveLength(0);
  expect(container.querySelector('[data-testid="input-balance"]')?.textContent).toBe("1,000");
  await flush(() => poll.resolve(vault));
});

it.each(["live", "scripted", "attacker"])("shows visible progress and a polite announcement during the %s scenario", async (mode) => {
  const response = Promise.withResolvers<Response>();
  const refresh = Promise.withResolvers<void>();
  const busy = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/agent/info"
    ? Response.json(mode === "scripted" ? {} : { model: "test-model" }) : response.promise));
  await flush(() => root.render(createElement(AgentConsole, {
    vault, finished: false, disabled: false, onBusy: busy, onComplete: () => refresh.promise,
  })));
  await flush(() => button(mode === "attacker" ? "Hacker redirect" : "Run normal trade").click());
  const label = mode === "live" ? "Asking the AI and checking the trade…" : "Sending to Solana…";
  expect(container.querySelector(".agent-result-area .agent-running")?.textContent).toContain(label);
  expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(label);
  expect(container.querySelector('.agent-result-area[aria-busy="true"]')).not.toBeNull();
  expect(button("Running…").querySelector(".progress-spinner")).not.toBeNull();
  expect([...container.querySelectorAll("button")].every((element) => element.disabled)).toBe(true);
  expect(busy).toHaveBeenLastCalledWith(true);
  await flush(() => response.resolve(Response.json({ steps: [{ type: "result", result: { ok: true, signature: "test-result" } }] })));
  expect(container.querySelector(".agent-running")?.textContent).toContain("Refreshing vault…");
  await flush(() => refresh.resolve());
  expect(container.querySelector(".agent-running")).toBeNull();
  expect(container.textContent).toContain("Trade went through");
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("turns every loader animation off for reduced motion while retaining static indicators", () => {
  const css = readFileSync("src/styles.css", "utf8");
  expect(css).toMatch(/\.progress-spinner\s*\{[^}]*border: 2px solid currentColor/);
  const reducedMotion = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reducedMotion).toContain("*, *::before, *::after { animation: none !important; transition: none !important; }");
});
