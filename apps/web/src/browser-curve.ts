import { getAddressDecoder, isOffCurveAddress } from "@solana/kit";

// PublicKey needs only point validation for PDA derivation. Kit exposes that
// independently of key generation and signing, unlike the legacy crypto bundle.
export function isOnCurve(bytes: Uint8Array): boolean {
  return bytes.length === 32 && !isOffCurveAddress(getAddressDecoder().decode(bytes));
}
