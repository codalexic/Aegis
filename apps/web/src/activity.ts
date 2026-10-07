import type { VersionedTransactionResponse } from "@solana/web3.js";
import type { VaultState } from "@aegis/sdk";
import { AEGIS_PROGRAM_ID, deriveSwapAccounts } from "../../../packages/sdk/src/addresses";
import { rawAmountToUi } from "../../../packages/sdk/src/amounts";
import idl from "../../../artifacts/idl/aegis.json";

export type ActionDetail = { label: string; amount: string };

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
      if (instruction?.name === "create_vault") return { label: "Create vault", amount: "—" };
      if (instruction?.name === "revoke_agent") return { label: "Revoke agent", amount: "—" };
      if (data.length < 16) continue;
      if (instruction?.name === "execute_swap") return { label: "Agent swap", amount: `${rawAmountToUi(view.getBigUint64(8, true), 6)} testUSDC` };
      if (instruction?.name === "withdraw") {
        const sourceIndex = instruction.accounts.findIndex((account) => account.name === "source");
        const source = keys.get(ix.accountKeyIndexes[sourceIndex]);
        const output = source?.equals(accounts.outputVault);
        if (!output && !source?.equals(accounts.inputVault)) continue;
        return { label: "Withdraw", amount: `${rawAmountToUi(view.getBigUint64(8, true), output ? 9 : 6)} ${output ? "testSOL" : "testUSDC"}` };
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
