export const U64_MAX = (1n << 64n) - 1n;

export function isU64(value: bigint): boolean {
  return typeof value === "bigint" && value >= 0n && value <= U64_MAX;
}

function requireU64(value: bigint): bigint {
  if (!isU64(value)) throw new RangeError("Amount must be a bigint between 0 and u64::MAX.");
  return value;
}

function requireDecimals(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("Mint decimals must be an integer between 0 and 255.");
  }
}

/** Parse an unsigned raw amount from JSON without floating-point conversion. */
export function parseRawAmount(value: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new TypeError("Raw amount must be a decimal digit string.");
  }
  return requireU64(BigInt(value));
}

export function formatRawAmount(value: bigint): string {
  return requireU64(value).toString();
}

/** Reject excess fractional precision instead of rounding a requested trade. */
export function uiAmountToRaw(value: string, decimals: number): bigint {
  requireDecimals(decimals);
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    throw new TypeError("UI amount must be an unsigned decimal string.");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new RangeError("Amount has more precision than the mint supports.");
  return requireU64(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0"));
}

export function rawAmountToUi(value: bigint, decimals: number): string {
  requireU64(value);
  requireDecimals(decimals);
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString();
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
