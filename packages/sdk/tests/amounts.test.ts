import { describe, expect, it } from "vitest";
import { formatRawAmount, parseRawAmount, rawAmountToUi, U64_MAX, uiAmountToRaw } from "@aegis/sdk";

describe("exact amount conversions", () => {
  it.each([0n, 20_000_000n, 9_007_199_254_740_993n, U64_MAX])("round-trips raw %s through a JSON decimal string", (raw) => {
    const json = JSON.stringify({ amount: formatRawAmount(raw) });
    expect(JSON.parse(json).amount).toBe(raw.toString());
    expect(parseRawAmount(JSON.parse(json).amount)).toBe(raw);
  });

  it.each([
    ["20", 6, 20_000_000n, "20"],
    ["0.2", 9, 200_000_000n, "0.2"],
    ["0.000001", 6, 1n, "0.000001"],
    ["00020.120000", 6, 20_120_000n, "20.12"],
    ["9007199254.740993", 6, 9_007_199_254_740_993n, "9007199254.740993"],
    ["18446744073709.551615", 6, U64_MAX, "18446744073709.551615"],
    ["42", 0, 42n, "42"],
    ["0", 9, 0n, "0"],
  ] as const)("converts %s with %s decimals exactly", (ui, decimals, raw, formatted) => {
    expect(uiAmountToRaw(ui, decimals)).toBe(raw);
    expect(rawAmountToUi(raw, decimals)).toBe(formatted);
    expect(uiAmountToRaw(rawAmountToUi(raw, decimals), decimals)).toBe(raw);
  });

  it.each(["", "-1", "+1", "1.2", "1e6", " 20", "20 ", "0x10", "NaN", "18446744073709551616"])("rejects invalid raw string %s", (value) => {
    expect(() => parseRawAmount(value)).toThrow();
  });

  it.each(["", "-1", "+1", ".5", "1.", "1e6", "1,000", " 20", "NaN", "0.0000001", "18446744073709.551616"])("rejects malformed, over-precise or overflowing UI amount %s", (value) => {
    expect(() => uiAmountToRaw(value, 6)).toThrow();
  });

  it.each([-1n, U64_MAX + 1n])("rejects out-of-range raw bigint %s", (raw) => {
    expect(() => formatRawAmount(raw)).toThrow();
    expect(() => rawAmountToUi(raw, 6)).toThrow();
  });

  it.each([-1, 1.5, 256, NaN, Infinity])("rejects invalid decimal metadata %s", (decimals) => {
    expect(() => uiAmountToRaw("1", decimals)).toThrow();
    expect(() => rawAmountToUi(1n, decimals)).toThrow();
  });

  it("rejects JavaScript numbers at runtime instead of accepting rounded token amounts", () => {
    expect(() => parseRawAmount(20 as unknown as string)).toThrow();
    expect(() => uiAmountToRaw(20 as unknown as string, 6)).toThrow();
    expect(() => formatRawAmount(20 as unknown as bigint)).toThrow();
  });
});
