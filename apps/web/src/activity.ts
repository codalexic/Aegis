import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import type { VaultState } from "@aegis/sdk";
import { AEGIS_PROGRAM_ID, deriveSwapAccounts } from "../../../packages/sdk/src/addresses";
import { rawAmountToUi } from "../../../packages/sdk/src/amounts";
import idl from "../../../artifacts/idl/aegis.json";

export type ActionDetail = { label: string; amount: string; destination?: string };

/** Read the requested amount from instruction bytes, including on rejected transactions. */
export function actionDetail(transaction: VersionedTransactionResponse, vault: VaultState): ActionDetail | undefined {
  const message = transaction.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: transaction.meta?.loadedAddresses });
  const accounts = deriveSwapAccounts(vault.address, vault.inputMint, vault.outputMint);
  for (const ix of message.compiledInstructions) {
    const program = keys.get(ix.programIdIndex);
    const data = ix.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (program?.equals(AEGIS_PROGRAM_ID)) {
      const instruction = idl.instructions.find((definition) => definition.discriminator.every((byte, i) => data[i] === byte));
      if (instruction?.name === "create_vault") return { label: "Create vault", amount: "0" };
      if (instruction?.name === "revoke_agent") return { label: "Revoke agent", amount: "0" };
      if (data.length < 16) continue;
      if (instruction?.name === "execute_swap") return { label: "Agent swap", amount: `${rawAmountToUi(view.getBigUint64(8, true), 6)} testUSDC` };
      if (instruction?.name === "withdraw" || instruction?.name === "withdraw_to") {
        const sourceIndex = instruction.accounts.findIndex((account) => account.name === "source");
        const source = keys.get(ix.accountKeyIndexes[sourceIndex]);
        const output = source?.equals(accounts.outputVault);
        if (!output && !source?.equals(accounts.inputVault)) continue;
        let destination = "your wallet";
        if (instruction.name === "withdraw_to") {
          const destinationIndex = instruction.accounts.findIndex((account) => account.name === "destination");
          const target = keys.get(ix.accountKeyIndexes[destinationIndex]);
          // The SDK includes an idempotent ATA creation carrying the recipient owner.
          const ata = message.compiledInstructions.find((candidate) =>
            keys.get(candidate.programIdIndex)?.equals(new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")) &&
            target?.equals(keys.get(candidate.accountKeyIndexes[1])!));
          const recipient = ata && keys.get(ata.accountKeyIndexes[2]);
          destination = recipient?.equals(vault.owner) ? "your wallet" : recipient?.toBase58() ?? target?.toBase58() ?? "allowed address";
        }
        return { label: "Withdraw", destination, amount: `${rawAmountToUi(view.getBigUint64(8, true), output ? 9 : 6)} ${output ? "testSOL" : "testUSDC"}` };
      }
    }
    // Original SPL Token TransferChecked: opcode 12, u64 amount, u8 decimals.
    if (program?.equals(accounts.tokenProgram) && data.length === 10 && data[0] === 12 &&
        keys.get(ix.accountKeyIndexes[2])?.equals(accounts.inputVault)) {
      return { label: "Fund vault", amount: `${rawAmountToUi(view.getBigUint64(1, true), 6)} testUSDC` };
    }
  }
  return undefined;
}
