# Mariam Four Day Contract Track

This document describes planned work, not an existing implementation. Mariam owns contracts and deployment; Alexis owns the client, SDK, agent, and UI. Budget: **32 focused hours across four days**, including integration and contingency. Starting from an empty repository is feasible only if Mariam already knows Rust/Anchor and can use a working local Solana toolchain. Use [INTERFACES.md](INTERFACES.md) as the shared contract.

**Owned paths:** `programs/aegis/`, `programs/demo-dex/`, `tests/program/`, `artifacts/idl/`, `deployments/`, and `scripts/localnet/`. Deliver generated IDL and executable examples; do not change Alexis's client code during integration.

The baseline has one owner, one agent, one vault policy, and one fixed token pair. Policy is immutable at vault creation; only creating a new vault resets its budget. No replacement-session instruction, multiple sessions, generic router, route hashes, or private proofs. Defer fresh ZK and Jupiter work until after the demo. An already-working artifact may be shown separately, with its actual scope explained, without blocking this baseline.

## M01 Freeze the small contract boundary

**Day 1, first 3 hours — 3 hours.**

Create the Anchor workspace and agree the accounts, errors, events, IDL output, and fixture format with Alexis. Use one test runner: Anchor's local-validator integration suite under `tests/program/`; do not introduce a second harness.

Vault state includes `owner`, `agent`, `expiryUnix`, `nextNonce`, `spentRaw`, `maxTradeRaw`, `sessionBudgetRaw`, `revoked`, and the public mint/token-account addresses. Fix the demo DEX configuration and public `maxSlippageBps=100`. Freeze the instruction:

`execute_swap(ctx, amount_in_raw: u64, min_out_raw: u64, expected_nonce: u64, deadline_unix: i64)`

Only the authorized agent signs execution. Token amounts and nonces cross JSON as decimal strings; Rust uses checked integers. Chain time governs expiry. Require `chainTime < deadline_unix <= expiryUnix`. Fees are zero in the exchange; a separate fee payer covers network fees and account rent.

**Handoff:** approve the shared boundary in the first hour and provide the initial account/instruction scaffold by the end of this task so Alexis can prepare the real adapter. The implemented lifecycle IDL follows in M02 on the same day. No speculative interfaces for deferred features.

## M02 Implement the lifecycle and owner escape path

**Day 1 remaining 5 hours + Day 2 first 2 hours — 7 hours.**

Implement vault creation, funding support, irreversible owner revocation, and owner withdrawal. Use deterministic PDA authority and validate account ownership, signer, seeds/bump, fixed mint addresses/decimals, token program, and token-account authority. Creation records the immutable policy; no instruction increases it afterward.

Seed testUSDC with 6 decimals and testSOL with 9 decimals. Default cap is `50000000` input raw units; lifetime budget is `100000000`; expiry is one hour after creation. Additional deposits and withdrawals never reset `spentRaw`.

Fix the input and output vault token accounts. Agent privileges exclude withdrawals, policy edits, delegate approvals, authority reassignment, and closing vault accounts. Owner withdrawals work when the agent is revoked or expired and when the app is offline. No backend authorization is needed.

**Day 1 evening handoff:** real deployed local program, initial generated lifecycle IDL, fixture addresses, and an SDK-readable vault. Mark incomplete instructions explicitly. **Day 2 noon gate:** create/fund/revoke/withdraw are complete and demonstrated through owner-signed transactions.

## M03 Implement the real atomic test exchange

**Day 2 remaining 6 hours — 6 hours, including deployment attempt.**

Build `programs/demo-dex/` as a deterministic reserve exchange using real SPL token transfers. Fund its testSOL reserve. Fix the rate to 100 testUSDC = 1 testSOL: input `20000000` produces output `200000000`; the example minimum is `198000000`.

The Aegis instruction checks signer, revocation, time, nonce, positive amounts, per-trade cap, and remaining lifetime budget. Validate every account and call only the single configured demo DEX with typed arguments. Accept no generic CPI payload or caller-selected output account.

Calculate the quote with checked wide integer arithmetic. Enforce `min_out_raw >= ceil(quote * (10000 - maxSlippageBps) / 10000)`. Snapshot balances, invoke the swap, reload accounts, and require exact input debit plus actual output credit at least `min_out_raw`. Increment spent and nonce only on success; any failed postcondition rolls back transfers and state.

Timebox a devnet deployment attempt to **one hour**. If blocked, keep the actual local chain as the demonstration environment, clearly labeled. This fixed price is a demo reference, not live market or oracle protection.

**End Day 2 gate:** Alexis's SDK executes a real atomic swap using the generated IDL. Also run two direct smoke rejections: 60 units above the cap and a substituted destination. Save the program errors and unchanged state; expand the full attack suite on Day 3.

## M04 Prove the security boundaries

**Day 3 first 4 hours — 4 hours.**

Test valid 20-token trades and the exact cap boundary: 50 succeeds on a fresh vault; 60 fails despite sufficient total budget. Five 20-token trades consume exactly 100; a sixth fails. Confirm spent and nonce from chain state.

Cover replay, concurrent submissions using the same nonce, wrong signer, unauthorized withdrawal, revoked agent, expired vault/deadline, wrong token program or mint, substituted output account, insufficient reserves, a minimum output below the policy floor, and an excessive minimum output. Verify failed swaps leave both token balances, spent, and nonce unchanged. Include a reachable post-CPI failure in the local test harness to establish atomic rollback. Owner withdrawal must still work directly after revocation without the app or agent.

**Day 3 noon gate:** adversarial contract tests pass; Alexis's frontend uses real contract results. UI-only rejections do not count.

## M05 Integrate and freeze

**Day 3 remaining 4 hours — 4 hours.**

Fix integration defects jointly without changing ownership. Publish final IDL plus a manifest containing program IDs, cluster, build revision, mint decimals, fixture addresses, rate, public policy and disclosed program-upgrade/admin roles. Document which owner, agent and fee-payer signatures each terminal command requires. Keep private keys out of the manifest.

Provide repeatable local start/seed commands and valid/rejected transaction examples. Use fresh vaults for independent scenarios. **End Day 3:** freeze features and ABI. If UI work is incomplete, retain the SDK/CLI demonstration; never remove contract checks to meet the deadline.

## M06 Rehearsal evidence and contingency

**Day 4 — 8 hours: 3 rehearsal/evidence, 2 cleanup/regression, 3 contingency.**

Rehearse create/fund → valid trade → cap rejection → budget rejection → revoke → blocked trade → owner withdrawal. Capture actual signatures/logs and before/after state. Distinguish submitted failures from simulations, and label local-chain footage explicitly if used as fallback.

Run one clean setup, the contract suite, and owner recovery without the application. Deliver test assets only, a working demonstration, and accurate deployment instructions. Describe ZK/Jupiter as deferred and the contracts as unaudited demo software; do not claim production protection.
