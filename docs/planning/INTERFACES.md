# Aegis Four Day Shared Interfaces

Owners: Mariam and Alexis

Status: proposed implementation contract; approve during the first hour of Day 1

Scope: public policy, one immutable vault authorization, one fixed test DEX

[Main plan](../../AEGIS_PLAN.md) | [Mariam tasks](MARIAM_TASKS.md) | [Alexis tasks](ALEXIS_TASKS.md)

## 1 Freeze the smallest useful interface

Mariam implements the Anchor accounts and instructions. Alexis implements the matching SDK and application. Both agree on fields, account derivation, units and error meanings before parallel work.

The actual generated IDL is the ABI source of truth. Mariam publishes an initial IDL on Day 1 and refreshes it with each agreed instruction. Do not hand-edit an IDL or guess its account order in the SDK.

This four-day baseline has no separate Session account, policy replacement, private-cap mode, proof envelope, generic route payload or custom intent/route hashing. Authorization is stored directly in the vault. The agent signs the complete Solana transaction and the program validates the fixed operation.

## 2 Primitive types

| Value | JSON boundary | Implementation |
| --- | --- | --- |
| Address | Base58 string | Decode to 32-byte pubkey; validate against actual accounts |
| Amount, vault ID and nonce | Canonical unsigned decimal string | Checked u64; SDK arithmetic uses bigint |
| Expiry and deadline | Nonnegative decimal seconds | Validate against nonnegative i64; chain Clock is authoritative |
| Basis points | Integer number | u16, constrained to 0 through 10000 |
| Schema version | Integer 1 | DTO version only |
| Token selector | input or output | Maps to a supported enum in generated IDL |

Reject signs, fractions, exponent notation, overflow and noncanonical numerical strings. Token amounts never go through JavaScript Number. Use checked wide arithmetic for exchange calculations.

Require positive input and minimum-output amounts. A valid request satisfies chainTime < deadlineUnix <= expiryUnix. Client time is only a UI estimate.

## 3 Accounts and immutable policy

Proposed derivations, approved at G0:

| Account | Seeds under its program |
| --- | --- |
| Aegis configuration | ASCII config |
| Vault state | ASCII vault, owner pubkey bytes, vaultId as u64 little-endian |
| Vault authority | ASCII authority, vault state pubkey bytes |
| Demo pool | ASCII pool, input mint bytes, output mint bytes under demo DEX |
| Demo pool authority | ASCII pool-authority, pool pubkey bytes under demo DEX |

Use canonical bumps. The input/output vault token accounts are the vault authority's ATAs for the fixed original SPL Token program and mints. The pool has its own validated input/output reserves and authority. Record exact generated addresses in the manifest.

Aegis configuration fixes the supported demo DEX, pool, mints, original token program and test rate. Authenticate initialization against the agreed deployment authority. Configuration has no update instruction in this baseline. The on-chain program checks actual program/account identities rather than trusting a manifest supplied by the client.

Vault state records:

- Owner and agent pubkeys, vaultId and derivation bumps.
- Fixed input/output mint and vault token account identities.
- maxTradeRaw, sessionBudgetRaw, maxSlippageBps and expiryUnix.
- spentRaw, nextNonce and revoked.

The retained field name sessionBudgetRaw means the entire authorization budget of this vault; it does not imply a separate session implementation.

All policy fields and the agent are immutable after creation. Only spentRaw, nextNonce and revoked change. New authorization or a new budget requires a new owner-signed vault. There is no close/reinitialize, resume, replace-agent or policy-update instruction in this demo.

Deposits and withdrawals never reset spentRaw or nextNonce. Revocation permanently disables new agent swaps for this vault. Previously executed swaps are not undone. Owner withdrawal remains available after revocation, expiry or exhaustion.

## 4 SDK request types

These are proposed TypeScript exports to implement inside packages/sdk, with matching runtime validators.

```ts
type Address = string;
type U64String = string;
type UnixSeconds = string;

interface CreateVaultRequestV1 {
  version: 1;
  vaultId: U64String;
  agent: Address;
  maxTradeRaw: U64String;
  sessionBudgetRaw: U64String;
  maxSlippageBps: number;
  expiryUnix: UnixSeconds;
}

interface SwapRequestV1 {
  version: 1;
  vault: Address;
  amountInRaw: U64String;
  minOutRaw: U64String;
  expectedNonce: U64String;
  deadlineUnix: UnixSeconds;
}

interface VaultSnapshotV1 {
  version: 1;
  environment: "mock" | "localnet" | "devnet";
  vault: Address;
  owner: Address;
  agent: Address;
  inputMint: Address;
  outputMint: Address;
  inputVaultTokenAccount: Address;
  outputVaultTokenAccount: Address;
  maxTradeRaw: U64String;
  sessionBudgetRaw: U64String;
  spentRaw: U64String;
  nextNonce: U64String;
  maxSlippageBps: number;
  expiryUnix: UnixSeconds;
  revoked: boolean;
  inputBalanceRaw: U64String;
  outputBalanceRaw: U64String;
  observedSlot: U64String;
}

interface ExecutionReceiptV1 {
  environment: "mock" | "localnet" | "devnet";
  vault: Address;
  status:
    | "Prepared"
    | "SigningRejected"
    | "SimulationRejected"
    | "Submitted"
    | "Confirmed"
    | "Finalized"
    | "ChainFailed"
    | "UnknownOutcome";
  expectedNonce?: U64String;
  signature?: string;
  errorCode?: string;
  errorOrigin?: "client" | "simulation" | "aegis" | "demo_dex" | "rpc";
}
```

The owner is derived from the actual wallet signer. DEX, pool, mints and destination accounts come from validated chain state/configuration. There is no arbitrary recipient or caller-selected instruction payload in SwapRequestV1.

A prepared transaction is constructed only from supported IDL instructions. It contains no private key. Separate prepare, sign and submit; never accept arbitrary bytes as permission for a local key to sign.

## 5 Instructions and authorization

| Anchor instruction | Arguments | Required authorization |
| --- | --- | --- |
| create_vault | vaultId, agent, maxTradeRaw, sessionBudgetRaw, maxSlippageBps, expiryUnix | Owner signer; supported config and accounts |
| deposit | amountRaw | Owner signer and source-token authority |
| execute_swap | amountInRaw, minOutRaw, expectedNonce, deadlineUnix | Stored agent signer; validated fixed accounts |
| revoke_agent | No mutable policy arguments | Owner signer |
| withdraw | Supported asset selector, amountRaw | Owner signer; destination is owner's corresponding ATA |

getVaultState is an RPC read, not a write instruction. The table uses SDK camelCase arguments; the corresponding Rust swap arguments are amount_in_raw, min_out_raw, expected_nonce and deadline_unix. Confirm their generated IDL representation together when wiring the SDK.

The create path initializes spentRaw and nextNonce to zero and revoked to false. Validate positive cap/budget, cap <= budget, future expiry and supported basis points. Initialize only previously uninitialized vault state with a fresh vaultId.

For every execute_swap:

1. Validate account types, owner/authority relationships, program IDs, exact mints and fixed destinations.
2. Require the stored agent's signature, an active authorization, expected nonce and valid chain-time deadline.
3. Require positive amount, amount <= maxTradeRaw and checked spentRaw + amount <= sessionBudgetRaw.
4. Require enough input balance and a minimum output that respects the configured test-rate guard.
5. Snapshot balances and execute only the fixed typed test-DEX CPI.
6. Reload accounts; require actualInputDebit == amountInRaw and actualOutputCredit >= minOutRaw.
7. Increment spentRaw and nextNonce with checked arithmetic as part of the same atomic operation.

Any failure rolls back program state and token transfers. Transaction fees can still be charged. Reject arbitrary DEXs, pools, recipients, token programs, authority changes and unsupported account aliasing. The agent receives no withdraw, delegate, close or admin capability.

The test DEX is trusted demo code with funded reserves. The constrained CPI does not authorize arbitrary real-world routers. Configured program upgrade authorities remain disclosed trust assumptions.

## 6 Price fixture and minimum output

Use one fixed rate: 100 testUSDC = 1 testSOL. Input decimals are 6; output decimals are 9.

```text
quoteRaw = floor(amountInRaw * 1000000000 / (100 * 1000000))
guardRaw = ceil(quoteRaw * (10000 - maxSlippageBps) / 10000)
require minOutRaw >= guardRaw
require minOutRaw > 0
require actualOutputCredit >= minOutRaw
```

For amountInRaw 20000000 and maxSlippageBps 100:

- quoteRaw = 200000000.
- guardRaw = 198000000.
- Requesting less than 198000000 weakens the policy and is rejected.
- Requesting 201000000 cannot succeed at the fixed rate and must leave vault state unchanged.

Use checked u128 intermediates and bounded final conversions. Original SPL Token semantics avoid unsupported transfer-fee or hook behavior. The fixed rate is a test reference, not a live-market oracle.

## 7 Thin SDK and independent work

Implement one small injectable chain adapter with:

- getVaultState(vault).
- prepareCreateVault(request), prepareDeposit(vault, amount).
- prepareSwap(request).
- prepareRevoke(vault), prepareWithdraw(vault, asset, amount).
- signAndSubmit(prepared, localSignerHandle).
- getTransactionStatus(signature).

A signer handle is an in-process wallet or local signer, never a JSON secret. The same SDK is used by the owner dashboard, local agent script and CLI fallback. Owner operations work directly through the SDK if the UI or agent is offline.

Alexis's Day 1 stub supplies sample state and receipts for UI work. It is deliberately small, clearly marked mock, and not a second security implementation. Replace create/fund/read with the real adapter by G1 and swap/lifecycle by G2.

Mariam provides program tests and a small CLI independently of the frontend. Neither developer must wait for an LLM, web server or indexer.

Use wallet integration for owner signing and a local delegated test key for the agent script. Do not build a general backend. A script receipt can be imported into the dashboard, but the signature, transaction status and resulting state must be independently checked through RPC.

## 8 Stable errors and transaction states

| Semantic identifier | Meaning |
| --- | --- |
| AEGIS_INVALID_REQUEST | Invalid encoding, amount range or unsupported field |
| AEGIS_OWNER_REQUIRED | Missing owner authority |
| AEGIS_AGENT_UNAUTHORIZED | Wrong agent signer |
| AEGIS_REVOKED | Authorization revoked |
| AEGIS_EXPIRED | Vault authorization expired |
| AEGIS_DEADLINE_INVALID | Request deadline passed or exceeds authorization |
| AEGIS_NONCE_MISMATCH | Stale, repeated or out-of-order request |
| AEGIS_CAP_EXCEEDED | Per-trade cap exceeded |
| AEGIS_BUDGET_EXCEEDED | Cumulative authorization budget exceeded |
| AEGIS_ACCOUNT_MISMATCH | Wrong mint, program, pool, authority or destination |
| AEGIS_MIN_OUT_TOO_LOW | Requested minimum weakens the price guard |
| AEGIS_MIN_OUT_NOT_MET | Actual output does not satisfy the minimum |
| AEGIS_INSUFFICIENT_FUNDS | Insufficient supported input balance |

Mariam publishes numeric Anchor codes in the generated IDL; Alexis maps them without changing their meanings. Keep underlying DEX/RPC errors with their actual origin when no Aegis code applies.

SimulationRejected means preflight or explicit simulation failed; it does not imply a landed transaction. Submitted is not success. Confirmed and Finalized require the corresponding chain observation. Mock receipts have no fabricated signatures or explorer links.

For UnknownOutcome, retain any signature and reconcile signature status, vault nonce and balances before resubmitting. Do not silently use a new nonce or different amount as a retry. The unique vault and checked nonce prevent duplicate accepted execution.

## 9 Shared fixtures and acceptance

Keep one fixture set in tests/fixtures, consumed by both program and SDK tests.

| Fixture | Setup | Required result |
| --- | --- | --- |
| allowed20 | Fresh funded vault; input 20000000; minOut 198000000 | Output 200000000; spent 20000000; nextNonce 1 |
| capBoundary50 | Fresh vault; input 50000000 | Accepted if all other conditions hold |
| cap60 | Fresh 50-cap/100-budget vault; input 60000000 | AEGIS_CAP_EXCEEDED |
| budgetSixth | Five accepted 20-unit swaps, then a sixth | AEGIS_BUDGET_EXCEEDED |
| replay | Repeat an accepted nonce | AEGIS_NONCE_MISMATCH |
| concurrentNonce | Two submissions using the same current nonce | At most one succeeds |
| wrongSigner | Use an unauthorized local signer | AEGIS_AGENT_UNAUTHORIZED |
| unauthorizedWithdrawal | Agent attempts owner withdrawal | AEGIS_OWNER_REQUIRED |
| redirected | Supply a different output token account directly | Contract rejection despite bypassing UI |
| wrongMintOrProgram | Substitute an unsupported mint/token/DEX program | Contract rejection |
| weakMinimum | Request less than 198000000 for a 20-unit swap | AEGIS_MIN_OUT_TOO_LOW |
| impossibleMinimum | Request 201000000 for expected output 200000000 | Failure; balances, spent and nonce unchanged |
| expired | Use chain clock past expiry/deadline | Corresponding time rejection |
| revoked | Confirm revoke, then request a swap | AEGIS_REVOKED |
| outageExit | Stop UI and agent; use direct owner SDK | Withdrawal succeeds |

Allocate enough test funding and pool reserves for the intended failure condition. Use fresh vaults between independent cases; do not reset on-chain counters through a debug escape hatch.

Add a test that actually reaches a post-CPI failure and proves transaction rollback. Use a test-harness fault or narrowly controlled adverse fixture; do not add an agent-accessible production instruction that disables checks.

## 10 Deployment handoff

Mariam generates a public manifest containing:

- Environment and a redacted RPC endpoint or local environment-variable reference.
- Aegis and demo-DEX program IDs and configuration/pool addresses.
- Token program, input/output mint addresses and decimals.
- Test reserve addresses and configured exchange rate.
- Generated IDL path/hash, build identity and upgrade-authority public identity.
- Public fixture owner/agent identities and fresh vault IDs.

Private keys and authenticated RPC credentials stay in local ignored configuration. Both people can start the same local test environment. Agree on an existing working toolchain/WSL setup early; do not spend the sprint supporting multiple environments.

Timebox devnet troubleshooting to one hour on Day 2. Localnet fallback must execute the actual programs and SPL token transfers, not return mocked success.

## 11 Four day integration checkpoints

| Gate | Time | Evidence |
| --- | --- | --- |
| G0 | Day 1 first hour | Agreed schema, accounts, units, functions and errors |
| G1 | End of Day 1 | Real create/fund/read through SDK with initial IDL |
| G2 | End of Day 2 | Revoke/withdraw, actual swap, cap and destination failures |
| G3 | Day 3 midday | One real dashboard and local agent path |
| G4 | End of Day 3 | Mandatory acceptance cases pass and ABI freezes |
| G5 | End of Day 4 | Clean reset, repeated demo, test report and recording |

Re-run affected checks after an interface change. Preserve mock/localnet/devnet labels in every receipt and report. All tasks beyond these checkpoints belong to a later milestone.

ZK, custom proof encoding, hidden policies, Jupiter, live-market oracles and general-purpose execution are deferred. Their earlier specifications are not dependencies of this four-day baseline.
