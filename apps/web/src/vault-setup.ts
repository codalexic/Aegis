import { PublicKey } from "@solana/web3.js";
import { uiAmountToRaw } from "../../../packages/sdk/src/amounts";

export interface DemoVaultSettings {
  maxTradeRaw: bigint;
  budgetRaw: bigint;
  durationSeconds: bigint;
  withdrawAddresses: PublicKey[];
}
export const demoDefaults = (): DemoVaultSettings => ({
  maxTradeRaw: 50_000_000n, budgetRaw: 100_000_000n, durationSeconds: 3600n, withdrawAddresses: [],
});
export interface VaultSetupFields { cap: string; budget: string; until: string; addresses: string[] }

export function localDateTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  return new Date(milliseconds - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}
export const setupDefaults = (now = Date.now()): VaultSetupFields => ({
  cap: "50", budget: "100", until: localDateTime(now + 3_600_000), addresses: [],
});

export function addressErrors(addresses: string[], owner: PublicKey, agent: PublicKey): string[] {
  const seen = new Set<string>();
  return addresses.map((value, index) => {
    if (index >= 3) return "You can add up to 3 addresses.";
    let key: PublicKey;
    try { key = new PublicKey(value.trim()); } catch { return "Enter a valid Solana address."; }
    if (key.equals(owner)) return "Your wallet is already allowed.";
    if (key.equals(agent)) return "The demo agent cannot be a withdrawal address.";
    if (key.equals(PublicKey.default)) return "The system program cannot receive these funds.";
    const address = key.toBase58();
    if (seen.has(address)) return "This address is already in the list.";
    seen.add(address);
    return "";
  });
}

export function validateSetup(fields: VaultSetupFields, owner: PublicKey, agent: PublicKey, now = Date.now()) {
  const errors = { cap: "", budget: "", until: "", addresses: addressErrors(fields.addresses, owner, agent) };
  function parse(value: string, field: "cap" | "budget") {
    try {
      const raw = uiAmountToRaw(value, 6);
      if (raw === 0n) errors[field] = "Enter an amount greater than zero.";
      return raw;
    } catch { errors[field] = "Enter a positive amount with up to 6 decimal places."; return 0n; }
  }
  const maxTradeRaw = parse(fields.cap, "cap"), budgetRaw = parse(fields.budget, "budget");
  if (!errors.cap && !errors.budget && maxTradeRaw > budgetRaw) errors.cap = "Max per trade cannot exceed the total budget.";
  if (budgetRaw > 1_000_000_000n) errors.budget = "Total budget cannot exceed the 1,000 testUSDC demo deposit.";
  const milliseconds = new Date(fields.until).getTime() - now;
  const duration = Math.floor(milliseconds / 1000);
  if (!Number.isFinite(duration) || milliseconds < 300_000 || milliseconds > 30 * 86_400_000) errors.until = "Choose a time at least 5 minutes and at most 30 days from now.";
  const valid = !errors.cap && !errors.budget && !errors.until && !errors.addresses.some(Boolean);
  return { errors, settings: valid ? { maxTradeRaw, budgetRaw, durationSeconds: BigInt(duration),
    withdrawAddresses: fields.addresses.map((value) => new PublicKey(value.trim())) } satisfies DemoVaultSettings : null };
}
