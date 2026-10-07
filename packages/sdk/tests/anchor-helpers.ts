import { BN, BorshAccountsCoder, BorshInstructionCoder, utils, type Idl } from "@coral-xyz/anchor";
import { AccountLayout, AccountState, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, type AccountInfo, type TransactionError, type VersionedTransactionResponse } from "@solana/web3.js";
import { vi } from "vitest";
import idl from "../../../artifacts/idl/aegis.json";
import localnet from "../../../deployments/localnet.json";
import { AEGIS_PROGRAM_ID, AnchorAegisClient, deriveSwapAccounts, deriveVaultPda } from "../src/index";

// JSON imports widen literal strings; these raw coders intentionally keep the generated snake_case IDL.
export const instructionCoder = new BorshInstructionCoder(idl as Idl);
const accountCoder = new BorshAccountsCoder(idl as Idl);
export const NOW = 1_800_000_000n;
export const PRECISE_AMOUNT = 9_007_199_254_740_993n;

export function info(data: Buffer, owner = AEGIS_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, owner, executable: false, lamports: 1_000_000, rentEpoch: 0 };
}

export function tokenData(mint: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  return info(data, TOKEN_PROGRAM_ID);
}

export function errorLogs(program: PublicKey, code: number) {
  return [`Program ${program} invoke [1]`, `Program ${program} failed: custom program error: 0x${code.toString(16)}`];
}

export function transactionRecord(transaction: Transaction, err: TransactionError | null, logs: string[] = []): VersionedTransactionResponse {
  return {
    slot: 12, blockTime: Number(NOW),
    transaction: { message: transaction.compileMessage(), signatures: [utils.bytes.bs58.encode(transaction.signature!)] },
    meta: { err, fee: 5000, preBalances: [], postBalances: [], logMessages: logs },
  };
}

export async function fixture() {
  // Ephemeral test signers never leave memory. No disk keys, RPC or validator required.
  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const policy = { vaultId: PRECISE_AMOUNT, agent: agent.publicKey, maxTradeRaw: 50_000_000n, budgetRaw: PRECISE_AMOUNT, expiryUnix: NOW + 3600n };
  const [vault, bump] = deriveVaultPda(owner.publicKey, policy.vaultId);
  const inputMint = new PublicKey(localnet.inputMint);
  const outputMint = new PublicKey(localnet.outputMint);
  const accounts = deriveSwapAccounts(vault, inputMint, outputMint);
  const raw = {
    owner: owner.publicKey, agent: agent.publicKey, vault_id: new BN(policy.vaultId.toString()),
    input_mint: inputMint, output_mint: outputMint, input_vault: accounts.inputVault, output_vault: accounts.outputVault,
    max_trade_raw: new BN(policy.maxTradeRaw.toString()), budget_raw: new BN(policy.budgetRaw.toString()),
    expiry_unix: new BN(policy.expiryUnix.toString()), spent_raw: new BN("20000000"), revoked: false, bump, authority_bump: 0,
  };
  const vaultInfo = info(await accountCoder.encode("Vault", raw));
  const connection = new Connection(localnet.rpcUrl, "confirmed");
  const getAccountInfo = vi.spyOn(connection, "getAccountInfo").mockResolvedValue(vaultInfo);
  const getMultipleAccountsInfo = vi.spyOn(connection, "getMultipleAccountsInfo").mockResolvedValue([
    tokenData(inputMint, accounts.vaultAuthority, PRECISE_AMOUNT), tokenData(outputMint, accounts.vaultAuthority, 200_000_000n),
  ]);
  const lifetime = { blockhash: new PublicKey(new Uint8Array(32).fill(6)).toBase58(), lastValidBlockHeight: 999 };
  const getLatestBlockhash = vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue(lifetime);
  const sent: Transaction[] = [];
  const sendRawTransaction = vi.spyOn(connection, "sendRawTransaction").mockImplementation(async (bytes) => {
    const transaction = Transaction.from(bytes);
    sent.push(transaction);
    return utils.bytes.bs58.encode(transaction.signature!);
  });
  const confirmTransaction = vi.spyOn(connection, "confirmTransaction").mockResolvedValue({ context: { slot: 12 }, value: { err: null } });
  const getTransaction = vi.spyOn(connection, "getTransaction").mockResolvedValue(null);
  const getSignaturesForAddress = vi.spyOn(connection, "getSignaturesForAddress").mockResolvedValue([]);
  return {
    client: new AnchorAegisClient({ connection }), connection, owner, agent, policy, vault, inputMint, outputMint, accounts,
    raw, vaultInfo, sent, lifetime, getAccountInfo, getMultipleAccountsInfo, getLatestBlockhash,
    sendRawTransaction, confirmTransaction, getTransaction, getSignaturesForAddress,
    async setVault(overrides: Partial<typeof raw>) {
      getAccountInfo.mockResolvedValue(info(await accountCoder.encode("Vault", { ...raw, ...overrides })));
    },
  };
}
