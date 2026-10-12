import { describe, expect, it } from "vitest";
import { barInfo } from "../src/TradeBars";

describe("trade bar hover copy", () => {
  it("names the attack type and reason for blocked requests", () => {
    expect(barInfo({ amount: 1000, ok: false, error: "CapExceeded", time: "17:52" }, "testUSDC")).toEqual({
      kind: "Blocked · Fake news attack",
      reason: "This trade exceeds the vault’s per-trade cap.",
      meta: "1,000 testUSDC · 17:52",
    });
    expect(barInfo({ amount: 20, ok: false, error: "AccountMismatch" }, "testUSDC").kind).toBe("Blocked · Hacker redirect");
    expect(barInfo({ amount: 20, ok: false, error: "Revoked" }, "testUSDC").kind).toBe("Blocked by Aegis");
  });

  it("explains allowed requests", () => {
    expect(barInfo({ amount: 20, ok: true }, "testUSDC").kind).toBe("Allowed · Normal trade");
  });
});
