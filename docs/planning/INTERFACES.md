# Aegis Shared Interface

Approve in meeting M-1 (Day 1, first hour). After that, any change needs a written note to the other person and, for program changes, a regenerated IDL in the same commit.

[Main plan](../../AEGIS_PLAN.md) · [Mariam](MARIAM_TASKS.md) · [Alexis](ALEXIS_TASKS.md) · [Codex tasks](CODEX_TASKS.md)

## 1 Programs

| Program | Directory | Owner | Purpose |
| --- | --- | --- | --- |
| `aegis` | `programs/aegis` | Mariam | Vault, policy checks, swap through the test exchange |
| `demo_dex` | `programs/demo_dex` | Mariam | One pool, fixed rate, real SPL token transfers |

Both use the original SPL Token program (not Token-2022). `aegis` depends on `demo_dex` as a Rust crate with the `cpi` feature.

The generated IDL is the source of truth. `anchor build` writes it to `target/idl/`; `pnpm idl:sync` copies it to `artifacts/idl/`, which is committed. Never hand-edit it.

## 2 Accounts

| Account | Seeds | Program |
| --- | --- | --- |
| Vault | `"vault"`, owner pubkey, `vault_id` (u64 little-endian) | aegis |
| Vault authority | `"authority"`, vault pubkey | aegis |
| Pool | `"pool"`, input mint, output mint | demo_dex |
| Pool authority | `"pool-authority"`, pool pubkey | demo_dex |

The vault's token accounts (`input_vault`, `output_vault`) are the vault authority's associated token accounts for testUSDC and testSOL. The pool's reserves are the pool authority's associated token accounts for the same two mints.

**Vault fields:** `owner: Pubkey`, `agent: Pubkey`, `vault_id: u64`, `input_mint: Pubkey`, `output_mint: Pubkey`, `input_vault: Pubkey`, `output_vault: Pubkey`, `max_trade_raw: u64`, `budget_raw: u64`, `expiry_unix: i64`, `spent_raw: u64`, `revoked: bool`, `bump: u8`, `authority_bump: u8`.

Only `spent_raw` and `revoked` change after creation.

**Pool fields:** `input_mint`, `output_mint`, `input_reserve`, `output_reserve` (all `Pubkey`), `bump: u8`, `authority_bump: u8`.

## 3 `aegis` instructions

| Instruction | Arguments | Signer | Rules |
| --- | --- | --- | --- |
| `create_vault` | `vault_id: u64, agent: Pubkey, max_trade_raw: u64, budget_raw: u64, expiry_unix: i64` | owner (also pays rent) | cap > 0, cap ≤ budget, expiry > chain time, agent is not the default key or the owner, input mint ≠ output mint; creates the vault and both vault token accounts |
| `execute_swap` | `amount_in_raw: u64` | agent (also pays fees) | see below |
| `revoke_agent` | none | owner | sets `revoked = true` permanently |
| `withdraw` | `amount_raw: u64` | owner | source is `input_vault` or `output_vault`; destination is a token account owned by the owner with the same mint; signed by vault authority; works anytime, including after revoke or expiry |

Funding is a normal SPL token transfer from the owner into `input_vault`; the SDK wraps it as `fundVault`.

**`execute_swap` accounts:** `agent` (signer), `vault` (mut), `vault_authority`, `input_vault` (mut), `output_vault` (mut), `pool`, `pool_authority`, `input_reserve` (mut), `output_reserve` (mut), `demo_dex_program`, `token_program`.

**`execute_swap` checks, in order:**

1. Signer is `vault.agent`, else `Unauthorized`.
2. Not revoked (`Revoked`); chain time < `expiry_unix` (`Expired`).
3. 0 < amount (`InvalidAmount`); amount ≤ `max_trade_raw` (`CapExceeded`); `spent_raw + amount ≤ budget_raw` with checked arithmetic (`BudgetExceeded`).
4. Accounts match, else `AccountMismatch`: `input_vault`/`output_vault` equal the stored keys; pool is the PDA for the vault's mints under `demo_dex`; reserves equal the pool's stored reserves; `demo_dex_program` and `token_program` are the expected programs.
5. Record both vault balances, CPI `demo_dex::swap` signed by the vault authority PDA, reload both accounts.
6. Require input decreased by exactly `amount` and output increased by at least `amount × 10`, else `SwapResultMismatch`.
7. `spent_raw += amount` (checked).

Any failure reverts the whole transaction.

## 4 `demo_dex` instructions

| Instruction | Arguments | Accounts | Behaviour |
| --- | --- | --- | --- |
| `initialize_pool` | none | `payer` (signer, mut), `input_mint`, `output_mint`, `pool` (init PDA), `pool_authority` (PDA), `input_reserve` (init ATA), `output_reserve` (init ATA), `token_program`, `associated_token_program`, `system_program` | Creates the pool and empty reserves. The localnet script then funds `output_reserve` with a normal transfer |
| `swap` | `amount_in: u64` | `user_authority` (signer), `pool`, `pool_authority`, `user_input` (mut), `user_output` (mut), `input_reserve` (mut), `output_reserve` (mut), `token_program` | Moves `amount_in` from `user_input` to `input_reserve` (signed by `user_authority`), then `amount_in × 10` from `output_reserve` to `user_output` (signed by the pool authority PDA). Errors: `InvalidAmount`, `InsufficientReserve`, `AccountMismatch` |

The rate ×10 is a constant in `demo_dex`: 6-decimal testUSDC to 9-decimal testSOL at 100:1.

## 5 Errors

`aegis`:

| Error | Meaning |
| --- | --- |
| `Unauthorized` | Wrong signer (agent or owner) |
| `Revoked` | Agent was revoked |
| `Expired` | Vault expired |
| `InvalidAmount` | Zero amount or invalid policy at creation |
| `CapExceeded` | Over per-trade cap |
| `BudgetExceeded` | Over total budget |
| `AccountMismatch` | Wrong mint, pool, program or destination |
| `SwapResultMismatch` | Exchange did not deliver the expected balances |

Use `has_one = owner @ AegisError::Unauthorized` style constraints so Anchor's built-in failures map to these names. Numeric codes come from the IDL; the SDK maps them by name.

## 6 SDK (TypeScript, `packages/sdk`)

Amounts are `bigint` in code and decimal strings in JSON. Never use JavaScript `number` for token amounts.

```ts
interface AegisClient {
  readonly environment: "mock" | "localnet";
  getVault(vault: PublicKey): Promise<VaultState>;
  createVault(owner: Signer, p: { vaultId: bigint; agent: PublicKey; maxTradeRaw: bigint; budgetRaw: bigint; expiryUnix: bigint }): Promise<TxResult & { vault?: PublicKey }>;
  fundVault(owner: Signer, vault: PublicKey, amountRaw: bigint): Promise<TxResult>;
  swap(agent: Signer, vault: PublicKey, amountInRaw: bigint): Promise<TxResult>;
  revoke(owner: Signer, vault: PublicKey): Promise<TxResult>;
  withdraw(owner: Signer, vault: PublicKey, mint: PublicKey, amountRaw: bigint): Promise<TxResult>;
  listActivity(vault: PublicKey): Promise<Activity[]>;
}

interface VaultState {
  address: PublicKey; owner: PublicKey; agent: PublicKey;
  inputMint: PublicKey; outputMint: PublicKey;
  maxTradeRaw: bigint; budgetRaw: bigint; spentRaw: bigint;
  expiryUnix: bigint; revoked: boolean;
  inputBalanceRaw: bigint; outputBalanceRaw: bigint;
}

interface Activity {
  signature: string; slot: bigint; blockTime?: bigint;
  ok: boolean; error?: string; // aegis error name when the program rejected it
}

type TxResult =
  | { ok: true; signature: string }
  | { ok: false; signature?: string; error: string; origin: "client" | "program" | "rpc" };
```

Implementations:

- `MockAegisClient`: in-memory, returns the outcomes in §8. `environment = "mock"`. No fake signatures that look real; use `mock-<n>`.
- `AnchorAegisClient`: real, built from the IDL. `listActivity` uses `getSignaturesForAddress(vault)` then `getTransaction` to read success or the error name from logs.
- `swapRaw(agent, accounts, amountInRaw)`: attack-only helper that sends `execute_swap` with caller-chosen accounts and skips all client checks, so tests prove the program rejects attacks.

## 7 Keys, environment and dashboard signing

- `pnpm localnet` writes `deployments/localnet.json`: RPC URL, program IDs, mints, pool, reserves, and public keys of the test owner and agent.
- Test keypairs live in `.keys/owner.json` and `.keys/agent.json` (git-ignored). The agent script loads only the agent key. The AI model never sees any key; it only proposes an amount.
- **Dashboard signing (localnet only):** the browser never holds a key. A Vite dev-server plugin in `apps/web` exposes `POST /api/owner/{create,fund,revoke,withdraw}`; these run in Node, load `.keys/owner.json` and call the SDK. The browser reads chain state directly over RPC. The page shows "test key · localnet only". In mock mode the browser calls `MockAegisClient` directly.
- `AEGIS_ENV=mock|localnet` selects the client in the dashboard, agent and demo script.

## 8 Shared test cases

Program tests (`tests/program`) and end-to-end checks (`tests/e2e`) both cover these. Use a fresh vault per case, funded with 1,000 testUSDC, cap 50, budget 100, expiry one hour.

| Case | Expected |
| --- | --- |
| Normal swap 20 | Succeeds; +200000000 testSOL; spent 20000000 |
| Swap 50 | Succeeds (exact cap) |
| Swap 60 | `CapExceeded`, nothing changes |
| Five swaps of 20, then a sixth | Sixth fails `BudgetExceeded` |
| Output redirected to attacker account | `AccountMismatch` |
| Wrong signer | `Unauthorized` |
| Agent calls withdraw | `Unauthorized` |
| Swap after revoke | `Revoked` |
| Swap after expiry | `Expired` |
| Owner withdraws after revoke | Succeeds |

For every rejected case, also assert that both vault balances and `spent_raw` are unchanged.
