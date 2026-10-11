import { Buffer } from "buffer";
import { MessageV0, PublicKey } from "@solana/web3.js";
import { ClientError } from "./errors";

const computeBudget = new PublicKey("ComputeBudget111111111111111111111111111111");

function reject(reason: string): never {
  throw new ClientError("WalletModifiedTransaction", reason);
}

/** Compare compiled messages by addresses and privileges, not account indexes. */
export function validateWalletMessage(expected: MessageV0, actual: MessageV0): void {
  if (!actual.staticAccountKeys[0]?.equals(expected.staticAccountKeys[0])) reject("Fee payer changed.");
  if (actual.recentBlockhash !== expected.recentBlockhash) reject("Recent blockhash changed.");
  if (actual.addressTableLookups.length) reject("Address lookup tables added.");
  if (actual.header.numRequiredSignatures !== 1 || actual.header.numReadonlySignedAccounts !== 0) reject("Owner signer permissions changed.");

  const seen = new Set<string>();
  for (let index = 0; index < actual.staticAccountKeys.length; index++) {
    const key = actual.staticAccountKeys[index], address = key.toBase58();
    if (seen.has(address)) reject("Duplicate account added.");
    seen.add(address);
    const original = expected.staticAccountKeys.findIndex((candidate) => candidate.equals(key));
    if (original < 0) {
      if (!key.equals(computeBudget) || actual.isAccountWritable(index) || actual.isAccountSigner(index)) reject("Unexpected account added.");
    } else if (actual.isAccountSigner(index) !== expected.isAccountSigner(original) ||
        actual.isAccountWritable(index) !== expected.isAccountWritable(original)) reject("Account permissions changed.");
  }
  if (expected.staticAccountKeys.some((key) => !seen.has(key.toBase58()))) reject("Account removed.");

  let next = 0;
  const budgetTypes = new Set<number>();
  for (const instruction of actual.compiledInstructions) {
    const program = actual.staticAccountKeys[instruction.programIdIndex];
    const original = expected.compiledInstructions[next];
    if (original && program?.equals(expected.staticAccountKeys[original.programIdIndex]) &&
        Buffer.from(instruction.data).equals(Buffer.from(original.data)) &&
        instruction.accountKeyIndexes.length === original.accountKeyIndexes.length &&
        instruction.accountKeyIndexes.every((index, position) => actual.staticAccountKeys[index]?.equals(expected.staticAccountKeys[original.accountKeyIndexes[position]]))) {
      next++;
      continue;
    }
    if (!program?.equals(computeBudget)) reject("Original instruction changed, removed, reordered, or an unapproved instruction added.");
    const data = Buffer.from(instruction.data), type = data[0];
    if (instruction.accountKeyIndexes.length || budgetTypes.has(type)) reject("Invalid or duplicate compute budget instruction.");
    if (type === 2 && data.length === 5) {
      const units = data.readUInt32LE(1);
      if (units === 0 || units > 1_400_000) reject("Compute unit limit is outside the allowed range.");
    } else if (type === 3 && data.length === 9) {
      if (data.readBigUInt64LE(1) > 1_000_000n) reject("Compute unit price exceeds the allowed maximum.");
    } else reject("Unsupported or malformed compute budget instruction.");
    budgetTypes.add(type);
  }
  if (next !== expected.compiledInstructions.length) reject("Original instruction removed.");
}
