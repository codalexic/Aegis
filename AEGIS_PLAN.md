# Aegis Four Day Technical Plan

Updated: 6 October 2026

Deadline: four focused workdays from the team's agreed start

Team: **Mariam** owns contracts; **Alexis** owns the SDK, agent and UI.

Capacity: approximately eight focused hours per person per day, including integration and fixes.

Status: planning documents only; implementation has not started in this repository.

## 1 Four day deliverable

Build an actual Solana demonstration of **on-chain spending controls using a test DEX**: an allowed swap succeeds, a malicious request fails in the program, and the owner can revoke the agent and withdraw remaining test assets.

The deadline changes the scope. It does not turn the previous plan into a four-day production build. This is an aggressive target for two developers already familiar with their tools.

| Required in four days | Deferred until after the demo |
| --- | --- |
| PDA vault; one owner and one agent | Integrated ZK, hidden policy and prover service |
| One fixed original SPL Token pair | Jupiter routing and live-market price protection |
| Public cap, cumulative budget, expiry and nonce | Multiple sessions, policy updates and agent rotation |
| Owner revoke and withdrawal | Arbitrary CPI, token extensions, lending and leverage |
| Real test-DEX CPI and atomic balance checks | General REST API, indexer and separate services |
| Thin SDK, one dashboard, one local agent script | Published SDK, three-screen application and social onboarding |
| Deterministic attack tests and repeatable localnet demo | Billing, real customer funds and production launch |

**ZK and Jupiter have no implementation allocation during these four days.** An already working independent artifact may be shown separately, accurately labelled; it cannot block the baseline or be described as integrated. No new cryptography or routing research starts during this sprint.

## 2 Owners and first steps

| Person | Owns | Task file |
| --- | --- | --- |
| Mariam | Anchor vault, policy checks, test DEX, atomic execution, contract tests, IDL and deployment | [Mariam tasks](docs/planning/MARIAM_TASKS.md) |
| Alexis | Thin TypeScript SDK, one dashboard, local agent script, receipts and integration tests | [Alexis tasks](docs/planning/ALEXIS_TASKS.md) |
| Both | First-hour interface freeze, daily integration and final rehearsal | [Shared interfaces](docs/planning/INTERFACES.md) |

Approve the shared interface in the first hour. Alexis starts with a small labelled stub while Mariam builds the actual program. Connect a real SDK read before Day 1 ends.

Each task file contains six tasks totalling approximately 32 hours. These are planning limits, not guarantees. Day 4 includes contingency and is reserved for completion, not adding deferred features.

## 3 Fixed configuration

| Setting | Value |
| --- | --- |
| Input | testUSDC, original SPL Token, 6 decimals |
| Output | testSOL, original SPL Token, 9 decimals |
| Direction | testUSDC to testSOL only |
| Vault funding | 1,000 testUSDC |
| Per-trade cap | 50 testUSDC = 50000000 raw units |
| Authorization budget | 100 testUSDC = 100000000 raw units |
| Expiry | One hour from vault creation |
| Test rate | 100 testUSDC = 1 testSOL |
| Maximum demo slippage | 100 basis points against the fixed rate |
| Application fee | Zero; a separate fee payer covers network fees |
| Allowed swap | 20000000 input raw -> 200000000 output raw |
| Minimum output for that swap | At least 198000000 raw |
| Isolated cap failure | 60 testUSDC against a fresh 100-unit budget |
| Budget test | Five accepted 20-unit trades; sixth rejected |

These are test assets, not real USDC or SOL. The fixed rate is a deterministic test reference, not live-market oracle protection.

Policy is immutable at vault creation. Deposits and withdrawals do not reset spending. Revocation is irreversible for that vault. A new owner-approved vault is the only reset or new-authorization mechanism; no session-replacement or policy-update instruction is built.

## 4 Architecture and file ownership

The owner wallet creates, funds, revokes and withdraws. A local agent script calls the thin SDK, which constructs one typed execute-swap instruction. The program checks signer, accounts, limits, budget, nonce and chain time, calls the fixed test DEX, checks actual balance changes and commits or rolls back atomically.

The dashboard reads vault state and verifies transaction status through RPC. The agent script holds only its delegated test key locally. Any optional model connection proposes structured requests and never receives a private key.

A PDA is the vault authority. Its program-signing mechanism still requires correct account and CPI checks. [Solana PDA documentation](https://solana.com/docs/core/pda)

| Proposed path | Owner and purpose |
| --- | --- |
| programs/aegis | Mariam: vault and fixed execution |
| programs/demo-dex | Mariam: reserve-backed deterministic test exchange |
| tests/program | Mariam: one contract test harness |
| artifacts/idl and deployments | Mariam: generated IDL and public manifest |
| scripts/localnet | Mariam: start, seed and reset |
| packages/sdk | Alexis: types, thin SDK and stub/real adapter |
| apps/web | Alexis: one dashboard |
| scripts/agent and scripts/demo | Alexis: agent, scenarios and evidence |
| tests/e2e | Alexis: SDK-to-program tests |
| tests/fixtures | Shared: one canonical fixture set |

Only the planning files currently exist. These paths are implementation targets.

Do not add standalone API, agent-server, prover or indexing services. The dashboard may verify a pasted/imported receipt through RPC instead of adding a backend to discover agent activity. Receipt JSON is not itself chain evidence.

Mariam owns Anchor configuration and the Rust lockfile. Alexis owns the JavaScript configuration and lockfile. Choose one familiar contract testing route. [Anchor Testing](https://www.anchor-lang.com/docs/testing)

Proposed implementation branches are feature/mariam-program and feature/alexis-client, merged through integration/aegis-demo at each gate. This plan does not create branches. Coordinate changes to the shared interface and generated IDL.

## 5 Four day schedule

Each column is one person's work within roughly eight focused hours per day.

| Day | Mariam | Alexis | Shared outcome |
| --- | --- | --- | --- |
| Day 1 | Toolchain, account model, vault creation/funding, initial IDL | Shared types, SDK stub, dashboard scaffold and first real adapter call | Real localnet create/fund/read through the SDK |
| Day 2 | Revoke/withdraw by midday; test DEX, swap and policy checks | Complete owner lifecycle, SDK swap, local agent script and dashboard wiring | Actual swap plus cap/destination rejection through SDK |
| Day 3 | Adversarial tests and integration fixes | Dashboard, receipts, attack scenarios and E2E tests | Dashboard by midday; baseline passes and features freeze by end of day |
| Day 4 | Regression, environment verification, clean reset and contingency | Rehearsal, evidence, startup instructions and backup video | Reproducible demo and matching build/IDL/configuration |

### Integration gates

| Gate | Deadline | Acceptance |
| --- | --- | --- |
| G0 | Day 1 first hour | Both approve accounts, instruction arguments, units, fixtures and errors |
| G1 | End of Day 1 | Real vault create/fund/read works through Alexis's SDK |
| G2 | End of Day 2 | Owner lifecycle, atomic swap and direct cap/destination failures work |
| G3 | Day 3 midday | Dashboard and local agent use the actual program |
| G4 | End of Day 3 | Mandatory tests pass; ABI and features freeze |
| G5 | End of Day 4 | Clean setup, repeated demo, evidence and video ready |

Hold a 15-minute midday check and a 15-minute end-of-day check. Build separately between them, but connect small working paths throughout. Do not leave first integration until the final day.

## 6 Cutoffs and fallback decisions

- If G1 fails, start Day 2 together on the actual program/IDL connection. Pause interface polish and live-model work.
- On Day 2, spend at most one hour on devnet deployment, faucet or RPC problems. If unsuccessful, complete the demo on real localnet programs with clear environment labels.
- If G2 fails, use Day 3 to finish the actual swap and authorization. A CLI demo is acceptable; a false security claim is not.
- If G3 is at risk, remove live LLM interaction, animation, persisted activity and secondary controls. Retain deterministic requests and verifiable receipts.
- At the end of Day 3, freeze features. ABI changes are limited to fixing required failed checks.
- Day 4 is for fixes and rehearsal. Clearly label a backup recording. If only vault controls work, present that partial result without claiming completed swap integration.

Do not cut signer/account validation, cumulative budget, nonce, owner recovery or atomic output checks to save time. Scope may shrink, but the demonstrated guarantee must match the implementation.

## 7 Mandatory acceptance tests

Fund both the vault and test-DEX reserves sufficiently. Use fresh vaults when isolating rules so a test fails for the intended reason.

| Case | Mariam verifies | Alexis verifies |
| --- | --- | --- |
| Owner lifecycle | Owner authorization | Wallet/script flow and actual state |
| Allowed 20-unit swap | Correct input/output deltas, budget and nonce | Real receipt and refreshed balances |
| Cap boundary | 50 allowed if budget permits; 60 rejected | Intended error and unchanged state |
| Cumulative spending | Fifth 20-unit swap consumes budget; sixth fails | Repeatable sequence on a fresh vault |
| Wrong signer/destination/mint | Direct contract rejection | Test bypasses UI validation |
| Replay and concurrent nonce | At most one execution per nonce | Retry does not silently change request |
| Deadline and expiry | Chain-time enforcement | Accurate expiry state |
| Revocation | Later agent execution rejected | Owner withdrawal still works |
| Weak/excessive minimum output | Price guard and atomic rollback | Correct failure origin and state |
| Agent/UI outage | Owner exit requires no service | Direct owner SDK withdrawal |

An off-chain refusal is not proof of on-chain enforcement. Distinguish a simulation rejection from a submitted chain failure. Network fees are separate from unchanged vault-token balances.

## 8 Three minute demonstration

| Time | Show |
| --- | --- |
| 0:00-0:30 | Owner, agent, test-token labels, public cap and budget |
| 0:30-1:00 | Create/fund, or a fresh seeded vault with verifiable state |
| 1:00-1:35 | Allowed 20-unit swap, actual receipt and balances |
| 1:35-2:10 | Deterministic malicious 60-unit request rejected by the program |
| 2:10-2:35 | Revoke agent and show a subsequent request failing |
| 2:35-3:00 | Owner withdrawal; ZK and Jupiter clearly marked as future work |

The automated suite also covers cumulative budget, replay and rollback. The stage claim is: the contract blocks operations outside these configured test-vault permissions.

## 9 Final handoff

- [ ] Both people can start the actual environment and reset a fresh vault.
- [ ] Generated IDL, program IDs and manifest match the deployed build.
- [ ] Create, fund, execute, revoke and withdraw work.
- [ ] Mandatory rejection and rollback tests pass.
- [ ] Presented SDK/dashboard results come from actual state.
- [ ] Test assets, environment and attack simulation are labelled.
- [ ] No private key is committed or exposed to a model.
- [ ] Build identity, test output and transaction evidence are saved.
- [ ] Startup instructions and a three-minute recording are ready.
- [ ] ZK, Jupiter and production deployment are described as future work.

After the deadline, resume Jupiter integration, independent price validation and the hidden-cap proof as separate milestones. Real-money use requires later security review and an explicit deployment/upgrade-control decision.
