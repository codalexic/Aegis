import { PublicKey } from "@solana/web3.js";
import { expect, it } from "vitest";
import { localDateTime, setupDefaults, validateSetup } from "../src/vault-setup";
const owner = new PublicKey(new Uint8Array(32).fill(3)), agent = new PublicKey(new Uint8Array(32).fill(4));
const extra = new PublicKey(new Uint8Array(32).fill(5)).toBase58();
const now = 1_800_000_000_000;

it.each([
  ["0", "100", false], ["50", "0", false], ["-1", "100", false], ["1e2", "100", false],
  ["0.000001", "1000", true], ["1.0000001", "100", false], ["1", "1000.000001", false],
  ["101", "100", false], ["100", "100", true], ["", "100", false], ["1", "2.0000001", false],
])("validates cap %s and budget %s", (cap, budget, valid) => {
  expect(!!validateSetup({ ...setupDefaults(now), cap, budget }, owner, agent, now).settings).toBe(valid);
});
it.each([[299, false], [300, true], [3600, true], [86400, true], [604800, true], [2592000, true], [2592001, false], [-1, false]])(
  "validates duration %s", (seconds, valid) => {
    const result = validateSetup({ ...setupDefaults(now), until: localDateTime(now + seconds * 1000) }, owner, agent, now);
    expect(!!result.settings).toBe(valid);
    if (valid) expect(result.settings!.durationSeconds).toBe(BigInt(seconds));
  });
it("rejects empty dates and dates that become too soon while setup is open", () => {
  expect(validateSetup({ ...setupDefaults(now), until: "" }, owner, agent, now).errors.until).toBeTruthy();
  expect(validateSetup(setupDefaults(now), owner, agent, now + 3_301_000).errors.until).toBeTruthy();
});
it.each([
  [["invalid"], "valid Solana"], [[owner.toBase58()], "already allowed"], [[agent.toBase58()], "demo agent"],
  [[extra, extra], "already in the list"], [[PublicKey.default.toBase58()], "system program"],
  [[extra, extra, extra, extra], "up to 3"], [[""], "valid Solana"],
])("rejects invalid address list %s", (addresses, message) => {
  const result = validateSetup({ ...setupDefaults(now), addresses }, owner, agent, now);
  expect(result.settings).toBeNull(); expect(result.errors.addresses.join(" ")).toContain(message);
});
it("accepts up to three distinct addresses", () => {
  const addresses = [5, 6, 7].map((byte) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58());
  expect(validateSetup({ ...setupDefaults(now), addresses }, owner, agent, now).settings?.withdrawAddresses.map((key) => key.toBase58())).toEqual(addresses);
});
