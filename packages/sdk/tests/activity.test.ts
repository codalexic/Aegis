import { afterEach, describe, expect, it, vi } from "vitest";
import { AEGIS_PROGRAM_ID } from "../src/index";
import { errorLogs, fixture, transactionRecord } from "./anchor-helpers";

afterEach(() => vi.restoreAllMocks());

describe("RPC activity", () => {
  it("reads confirmed successes/rejections, keeps newest-first order, bigint slots/times and exact error names", async () => {
    const f = await fixture();
    await f.client.revoke(f.owner, f.vault); // A signed message for RPC response fixtures only.
    const err = { InstructionError: [0, { Custom: 6004 }] };
    f.getSignaturesForAddress.mockResolvedValue([
      { signature: "rejected", slot: 21, blockTime: 1800000021, err, memo: null },
      { signature: "success", slot: 20, blockTime: 1800000020, err: null, memo: null },
    ]);
    f.getTransaction.mockResolvedValueOnce(transactionRecord(f.sent[0], err, errorLogs(AEGIS_PROGRAM_ID, 6004)))
      .mockResolvedValueOnce(transactionRecord(f.sent[0], null));
    expect(await f.client.listActivity(f.vault)).toEqual([
      { signature: "rejected", slot: 21n, blockTime: 1800000021n, ok: false, error: "CapExceeded" },
      { signature: "success", slot: 20n, blockTime: 1800000020n, ok: true },
    ]);
    expect(f.getSignaturesForAddress).toHaveBeenCalledWith(f.vault, { limit: 1000, before: undefined }, "confirmed");
    expect(f.getTransaction.mock.calls.map((call) => call[1])).toEqual([
      { commitment: "confirmed", maxSupportedTransactionVersion: 1 },
      { commitment: "confirmed", maxSupportedTransactionVersion: 1 },
    ]);
  });

  it("uses signature status when transaction details are missing and omits unknown block time", async () => {
    const f = await fixture();
    f.getSignaturesForAddress.mockResolvedValue([
      { signature: "missing-failed", slot: 2, blockTime: null, err: { InstructionError: [0, { Custom: 6001 }] }, memo: null },
      { signature: "missing-success", slot: 1, blockTime: null, err: null, memo: null },
    ]);
    expect(await f.client.listActivity(f.vault)).toEqual([
      { signature: "missing-failed", slot: 2n, ok: false, error: "CustomProgramError(6001)" },
      { signature: "missing-success", slot: 1n, ok: true },
    ]);
  });

  it("paginates rather than silently dropping activity older than 1000 signatures", async () => {
    const f = await fixture();
    const page = Array.from({ length: 1000 }, (_, i) => ({ signature: `sig-${1001 - i}`, slot: 1001 - i, err: null, memo: null, blockTime: null }));
    f.getSignaturesForAddress.mockResolvedValueOnce(page).mockResolvedValueOnce([
      { signature: "sig-1", slot: 1, err: null, memo: null, blockTime: null },
    ]);
    const activity = await f.client.listActivity(f.vault);
    expect(activity).toHaveLength(1001);
    expect(activity[0].signature).toBe("sig-1001");
    expect(activity.at(-1)?.signature).toBe("sig-1");
    expect(f.getSignaturesForAddress).toHaveBeenNthCalledWith(2, f.vault, { limit: 1000, before: "sig-2" }, "confirmed");
  });

  it("propagates RPC read failures without fabricating successful activity", async () => {
    const f = await fixture();
    f.getSignaturesForAddress.mockRejectedValue(new Error("RPC unavailable"));
    await expect(f.client.listActivity(f.vault)).rejects.toThrow("RPC unavailable");
  });
});
