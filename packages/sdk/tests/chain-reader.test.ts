import { afterEach, expect, it, vi } from "vitest";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { ChainReader } from "../src/chain-reader";
import { AEGIS_PROGRAM_ID } from "../src/addresses";
import deployment from "../../../deployments/devnet.json";

afterEach(() => vi.restoreAllMocks());
const vault = new PublicKey(deployment.owner);
const signature = (n: number) => ({ signature: `sig-${n}`, slot: n, blockTime: n, err: null });
const tx = new Transaction({ recentBlockhash: PublicKey.default.toBase58(), feePayer: vault })
  .add(SystemProgram.transfer({ fromPubkey: vault, toPubkey: PublicKey.default, lamports: 1n }));
const wire = { transaction: [tx.serialize({ requireAllSignatures: false }).toString("base64"), "base64"],
  slot: 1, meta: { err: null, logMessages: [] } };

function fixture() {
  const client = new ChainReader(deployment);
  let signatures = [signature(2), signature(1)];
  const rpc = vi.spyOn(client, "rpc").mockImplementation(async (method) => {
    if (method === "getSignaturesForAddress") return signatures;
    if (method === "getTransaction") return wire;
    throw new Error(method);
  });
  return { client, rpc, setSignatures: (next: typeof signatures) => { signatures = next; } };
}

it("loads only 20 initially, then uses until and reuses parsed details across consumers", async () => {
  const f = fixture();
  const first = await f.client.listActivity(vault);
  expect(first.map((item) => item.signature)).toEqual(["sig-2", "sig-1"]);
  expect(f.rpc.mock.calls[0]).toEqual(["getSignaturesForAddress", [vault.toBase58(), { commitment: "confirmed", limit: 20 }]]);
  await Promise.all(first.map((item) => f.client.getTransaction(item.signature)));
  expect(f.rpc.mock.calls.filter(([method]) => method === "getTransaction")).toHaveLength(2);
  f.setSignatures([signature(3)]);
  expect((await f.client.listActivity(vault)).map((item) => item.signature)).toEqual(["sig-3", "sig-2", "sig-1"]);
  expect(f.rpc.mock.calls[3][1][1]).toMatchObject({ until: "sig-2", limit: 20 });
  f.setSignatures([]);
  await f.client.listActivity(vault);
  expect(f.rpc.mock.calls.filter(([method]) => method === "getTransaction")).toHaveLength(3);
  expect(f.rpc.mock.calls.at(-1)![1][1]).toMatchObject({ until: "sig-3" });
});

it("bounds the first load and pages later bursts without losing the old cursor", async () => {
  const f = fixture();
  const page = Array.from({ length: 20 }, (_, i) => signature(20 - i));
  f.setSignatures(page);
  await f.client.listActivity(vault);
  expect(f.rpc.mock.calls.filter(([method]) => method === "getSignaturesForAddress")).toHaveLength(1);
  f.rpc.mockImplementation(async (method, params) => {
    if (method === "getTransaction") return wire;
    const config = params[1] as { before?: string; until: string };
    expect(config.until).toBe("sig-20");
    return config.before ? [signature(21)] : Array.from({ length: 20 }, (_, i) => signature(41 - i));
  });
  const history = await f.client.listActivity(vault);
  expect(history).toHaveLength(41);
  expect(history[0].signature).toBe("sig-41");
  expect(history[20].signature).toBe("sig-21");
});

it("shares concurrent activity loads and fetches transaction details sequentially", async () => {
  const f = fixture();
  let active = 0, peak = 0;
  f.rpc.mockImplementation(async (method) => {
    if (method === "getSignaturesForAddress") return [signature(2), signature(1)];
    active++; peak = Math.max(peak, active);
    await Promise.resolve(); active--;
    return wire;
  });
  const [a, b] = await Promise.all([f.client.listActivity(vault), f.client.listActivity(vault)]);
  expect(a).toEqual(b); expect(peak).toBe(1);
  expect(f.rpc).toHaveBeenCalledTimes(3);
});

it("keeps the cursor on partial failure and retries missing details without refetching cached parses", async () => {
  const f = fixture();
  await f.client.listActivity(vault);
  let missing = true;
  f.rpc.mockImplementation(async (method, params) => {
    if (method === "getSignaturesForAddress") {
      expect(params[1]).toMatchObject({ until: "sig-2" });
      return [signature(4), signature(3)];
    }
    return params[0] === "sig-3" && missing ? null : wire;
  });
  await expect(f.client.listActivity(vault)).rejects.toThrow("not available");
  missing = false;
  expect(await f.client.listActivity(vault)).toHaveLength(4);
  expect(f.rpc.mock.calls.filter(([method, args]) => method === "getTransaction" && args[0] === "sig-4")).toHaveLength(1);
});

it("keeps vault cursors separate and decodes program errors", async () => {
  const f = fixture();
  await f.client.listActivity(vault);
  f.rpc.mockImplementation(async (method, params) => {
    if (method === "getSignaturesForAddress") {
      expect(params[1]).not.toHaveProperty("until");
      return [signature(3)];
    }
    return { ...wire, meta: { err: { InstructionError: [0, { Custom: 6004 }] }, logMessages: [
      `Program ${AEGIS_PROGRAM_ID} invoke [1]`, `Program ${AEGIS_PROGRAM_ID} failed: custom program error: 0x1774`,
    ] } };
  });
  expect(await f.client.listActivity(PublicKey.default)).toMatchObject([{ ok: false, error: "CapExceeded" }]);
});
