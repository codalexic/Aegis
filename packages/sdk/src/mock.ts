import { PublicKey, type Signer } from "@solana/web3.js";
import { isU64, U64_MAX } from "./amounts";
import { deriveSwapAccounts, deriveVaultPda, deriveVaultAuthorityPda, deriveWithdrawPolicy } from "./addresses";
import type { Activity, AegisClient, CreateVaultParams, SwapAccounts, TxResult, VaultState, WithdrawPolicyState } from "./types";

// Public mock mint addresses only; no signing keys are generated or retained.
export const MOCK_INPUT_MINT = new PublicKey(new Uint8Array(32).fill(1));
export const MOCK_OUTPUT_MINT = new PublicKey(new Uint8Array(32).fill(2));

export interface MockClientOptions {
  inputMint?: PublicKey;
  outputMint?: PublicKey;
  now?: () => bigint;
}

/** In-memory simulation. Signer arguments are used only for their public identity. */
export class MockAegisClient implements AegisClient {
  readonly environment = "mock" as const;
  private readonly vaults = new Map<string, VaultState>();
  private readonly withdrawPolicies = new Map<string, WithdrawPolicyState>();
  private readonly activity = new Map<string, Activity[]>();
  private sequence = 0n;
  private readonly inputMint: PublicKey;
  private readonly outputMint: PublicKey;
  private readonly now: () => bigint;

  constructor(options: MockClientOptions = {}) {
    this.inputMint = options.inputMint ?? MOCK_INPUT_MINT;
    this.outputMint = options.outputMint ?? MOCK_OUTPUT_MINT;
    this.now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  }

  async getVault(vault: PublicKey): Promise<VaultState> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) throw new Error("VaultNotFound");
    return { ...state };
  }

  async createVault(owner: Signer, p: CreateVaultParams): Promise<TxResult & { vault?: PublicKey }> {
    if (!isU64(p.vaultId)) return { ok: false, error: "InvalidAmount", origin: "client" };
    const [vault] = deriveVaultPda(owner.publicKey, p.vaultId);
    if (!isU64(p.maxTradeRaw) || !isU64(p.budgetRaw) || p.maxTradeRaw === 0n ||
        p.maxTradeRaw > p.budgetRaw || typeof p.expiryUnix !== "bigint" ||
        p.expiryUnix <= this.now() || p.expiryUnix > (1n << 63n) - 1n ||
        this.inputMint.equals(this.outputMint)) {
      return this.record(vault, "InvalidAmount");
    }
    if (this.vaults.has(vault.toBase58())) return this.record(vault, "VaultAlreadyExists");
    const addresses = p.withdrawAddresses ?? [];
    const excluded = [PublicKey.default, vault, deriveVaultAuthorityPda(vault)[0], p.agent, owner.publicKey];
    if (addresses.length > 3 || addresses.some((address, index) => excluded.some((key) => key.equals(address)) ||
      addresses.slice(0, index).some((key) => key.equals(address)))) return this.record(vault, "InvalidAmount");
    if (addresses.length) this.withdrawPolicies.set(vault.toBase58(), { address: deriveWithdrawPolicy(vault)[0], vault, allowed: addresses.slice() });
    this.vaults.set(vault.toBase58(), {
      address: vault, owner: owner.publicKey, agent: p.agent,
      inputMint: this.inputMint, outputMint: this.outputMint,
      maxTradeRaw: p.maxTradeRaw, budgetRaw: p.budgetRaw, expiryUnix: p.expiryUnix,
      spentRaw: 0n, revoked: false, inputBalanceRaw: 0n, outputBalanceRaw: 0n,
    });
    return { ...this.record(vault), vault };
  }

  async fundVault(owner: Signer, vault: PublicKey, amountRaw: bigint): Promise<TxResult> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) return this.record(vault, "VaultNotFound");
    if (!owner.publicKey.equals(state.owner)) return this.record(vault, "Unauthorized");
    if (!isU64(amountRaw) || amountRaw === 0n || state.inputBalanceRaw + amountRaw > U64_MAX) {
      return this.record(vault, "InvalidAmount");
    }
    state.inputBalanceRaw += amountRaw;
    return this.record(vault);
  }

  async swap(agent: Signer, vault: PublicKey, amountInRaw: bigint): Promise<TxResult> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) return this.record(vault, "VaultNotFound");
    return this.swapRaw(agent, deriveSwapAccounts(vault, state.inputMint, state.outputMint), amountInRaw);
  }

  /** Simulate caller-selected accounts so the redirect scenario can run in mock mode. */
  async swapRaw(agent: Signer, accounts: SwapAccounts, amountInRaw: bigint): Promise<TxResult> {
    const state = this.vaults.get(accounts.vault.toBase58());
    const fail = (error: string) => this.record(accounts.vault, error);
    if (!state) return fail("VaultNotFound");
    if (!agent.publicKey.equals(state.agent)) return fail("Unauthorized");
    if (state.revoked) return fail("Revoked");
    if (this.now() >= state.expiryUnix) return fail("Expired");
    if (!isU64(amountInRaw) || amountInRaw === 0n) return fail("InvalidAmount");
    if (amountInRaw > state.maxTradeRaw) return fail("CapExceeded");
    const nextSpent = state.spentRaw + amountInRaw;
    if (nextSpent > U64_MAX || nextSpent > state.budgetRaw) return fail("BudgetExceeded");
    const expected = deriveSwapAccounts(state.address, state.inputMint, state.outputMint);
    for (const key of Object.keys(expected) as (keyof SwapAccounts)[]) {
      if (!accounts[key].equals(expected[key])) return fail("AccountMismatch");
    }
    const output = amountInRaw * 10n;
    if (output > U64_MAX) return fail("InvalidAmount");
    if (state.inputBalanceRaw < amountInRaw) return fail("InsufficientFunds");
    if (state.outputBalanceRaw + output > U64_MAX) return fail("SwapResultMismatch");
    // Apply all three changes together, after every simulated policy/balance check.
    state.inputBalanceRaw -= amountInRaw;
    state.outputBalanceRaw += output;
    state.spentRaw = nextSpent;
    return this.record(accounts.vault);
  }

  async revoke(owner: Signer, vault: PublicKey): Promise<TxResult> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) return this.record(vault, "VaultNotFound");
    if (!owner.publicKey.equals(state.owner)) return this.record(vault, "Unauthorized");
    state.revoked = true;
    return this.record(vault);
  }

  async rotateAgent(owner: Signer, vault: PublicKey, newAgent: PublicKey): Promise<TxResult> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) return this.record(vault, "VaultNotFound");
    if (!owner.publicKey.equals(state.owner)) return this.record(vault, "Unauthorized");
    if (newAgent.equals(PublicKey.default) || newAgent.equals(state.owner) || newAgent.equals(state.agent)) {
      return this.record(vault, "InvalidAmount");
    }
    state.agent = newAgent;
    state.revoked = false;
    return this.record(vault);
  }

  async withdraw(owner: Signer, vault: PublicKey, mint: PublicKey, amountRaw: bigint): Promise<TxResult> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) return this.record(vault, "VaultNotFound");
    if (!owner.publicKey.equals(state.owner)) return this.record(vault, "Unauthorized");
    const balance = mint.equals(state.inputMint) ? "inputBalanceRaw"
      : mint.equals(state.outputMint) ? "outputBalanceRaw" : undefined;
    if (!balance) return this.record(vault, "AccountMismatch");
    if (!isU64(amountRaw) || amountRaw === 0n) return this.record(vault, "InvalidAmount");
    if (state[balance] < amountRaw) return this.record(vault, "InsufficientFunds");
    state[balance] -= amountRaw;
    return this.record(vault);
  }

  async getWithdrawPolicy(vault: PublicKey): Promise<WithdrawPolicyState | null> {
    const policy = this.withdrawPolicies.get(vault.toBase58());
    return policy ? { ...policy, allowed: policy.allowed.slice() } : null;
  }

  async setWithdrawAddresses(owner: Signer, vault: PublicKey, addresses: PublicKey[]): Promise<TxResult> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) return this.record(vault, "VaultNotFound");
    if (!owner.publicKey.equals(state.owner)) return this.record(vault, "Unauthorized");
    if (this.withdrawPolicies.has(vault.toBase58())) return this.record(vault, "AccountAlreadyInUse");
    const excluded = [PublicKey.default, vault, deriveVaultAuthorityPda(vault)[0], state.agent, state.owner];
    if (addresses.length < 1 || addresses.length > 3 || addresses.some((address, index) =>
      excluded.some((key) => key.equals(address)) || addresses.slice(0, index).some((key) => key.equals(address)))) {
      return this.record(vault, "InvalidAmount");
    }
    this.withdrawPolicies.set(vault.toBase58(), { address: deriveWithdrawPolicy(vault)[0], vault, allowed: addresses.slice() });
    return this.record(vault);
  }

  async withdrawTo(owner: Signer, vault: PublicKey, mint: PublicKey, recipient: PublicKey, amountRaw: bigint): Promise<TxResult> {
    const state = this.vaults.get(vault.toBase58());
    if (!state) return this.record(vault, "VaultNotFound");
    if (!owner.publicKey.equals(state.owner)) return this.record(vault, "Unauthorized");
    const policy = this.withdrawPolicies.get(vault.toBase58());
    if (!policy) return this.record(vault, "AccountNotInitialized");
    if (!recipient.equals(state.owner) && !policy.allowed.some((address) => address.equals(recipient))) {
      return this.record(vault, "AccountMismatch");
    }
    return this.withdraw(owner, vault, mint, amountRaw);
  }

  async listActivity(vault: PublicKey): Promise<Activity[]> {
    return (this.activity.get(vault.toBase58()) ?? []).slice().reverse().map((item) => ({ ...item }));
  }

  private record(vault: PublicKey, error?: string): TxResult {
    const slot = ++this.sequence;
    const signature = `mock-${slot}`;
    const entry: Activity = { signature, slot, blockTime: this.now(), ok: error === undefined };
    if (error !== undefined) entry.error = error;
    const history = this.activity.get(vault.toBase58()) ?? [];
    history.push(entry);
    this.activity.set(vault.toBase58(), history);
    // Mock failures are client-side simulations, never real program transactions.
    return error === undefined ? { ok: true, signature } : { ok: false, signature, error, origin: "client" };
  }
}
