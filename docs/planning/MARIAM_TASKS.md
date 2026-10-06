# Mariam Contract Execution and Deployment Tasks

This is Mariam's implementation checklist for the 20-working-day Aegis demo. All items are planned work. Alexis owns the TypeScript types, SDK, API, agent, UI, application end-to-end tests, and circuit/prover. Mariam owns the Rust programs and contract-level evidence. The shared contract is [INTERFACES.md](INTERFACES.md); propose changes there through a joint decision before changing either implementation.

**Owned paths:** `programs/aegis/`, `programs/demo-dex/`, `tests/program/`, `artifacts/idl/`, `scripts/localnet/`, and the deployment manifest agreed in the interface document. Do not modify Alexis's implementation while integrating. Deliver generated IDL and working transaction examples rather than asking the SDK owner to infer the ABI from Rust.

The core supports only testUSDC (6 decimals) to testSOL (9 decimals), with a fixed demo exchange. Seeded policy: 50 testUSDC per trade (`50000000` raw), 100 testUSDC per session (`100000000` raw), one-hour expiry. These are test assets, not production USDC/SOL. Mainnet customer funds, unrestricted Jupiter routing, and production security claims are outside this plan.

## M01 Freeze interfaces and the execution boundary

**Days 1–2; depends on:** joint Day 1 interface agreement.

- Agree instruction arguments, account relationships, generated IDL location, error names/codes, event fields, fixture format, and canonical intent bytes with Alexis.
- Implement against `SwapIntentV1`: `version`, `vault`, `session`, `policyVersion`, `nonce`, `deadlineUnix`, `inputMint`, `outputMint`, `amountInRaw`, `minOutRaw`, `inputVaultTokenAccount`, `outputVaultTokenAccount`, `adapterProgramId`, `routeHash`, `feeCapRaw`.
- JSON integers representing amounts and nonce remain decimal strings; Rust validates bounds before converting to `u64`. Never introduce float amounts or hash JSON text.
- Validate canonical encoding with golden vectors. Recompute the request SHA-256 from the deployment domain, program ID and actual operation. The route hash includes ordered accounts, flags and instruction data; never trust a claimed digest.
- Record trusted components: owner signature, Aegis code, demo DEX code and configured token program. Agent, relayer, API data, and proof submitter remain untrusted.
- Begin the standalone private-cap verifier compatibility spike early and exchange hash/proof vectors with Alexis by Day 5. This is the feasibility gate; M07 is the later full integration.

**Done:** both developers reproduce the same intent bytes/hash and approve the account map. Publish an initial IDL/schema scaffold with clearly marked unfinished instructions.

## M02 Vault lifecycle and owner recovery

**Days 2–3; depends on:** M01.

- Implement initialization and owner-authorized withdrawal in `programs/aegis/`; provide deposit helpers in the localnet scripts.
- Derive the vault authority deterministically. Validate account owners, PDA seeds/bump, configured token program, exact mint addresses, mint decimals, and token-account authorities.
- Fix the permitted input/output vault token accounts. Never accept a caller-selected recipient for agent execution.
- Keep owner authority separate from agent authority. The agent cannot withdraw, assign delegates, change token authorities, close vault accounts, or replace the owner.
- Owner withdrawal must work without the backend, agent, or prover, including when the session has expired or been revoked. Withdrawals do not reset consumed session budget.

**Done on Day 3:** a reproducible CLI/script creates a vault, deposits test tokens, withdraws as owner, and fails withdrawal as agent. Handoff program IDs, IDL, fixture addresses, and successful/failed transaction examples to Alexis.

## M03 Immutable sessions and public policy

**Days 3–4; depends on:** M02.

Provide minimal create-session and revoke instructions with the M02 lifecycle by Day 3 for the real SDK gate. Complete the remaining policy/accounting cases on Day 4; do not block lifecycle integration on the swap implementation.

- Owner alone creates or replaces a session and selects its agent signer. Store its policy, mode, expiry, total spent, and expected nonce on-chain.
- Keep each session policy immutable. Changing limits means owner-authorized replacement; replacement changes the active session and invalidates the old one.
- Give each session a unique generation/address that is never reused. Nonce advances within that session; replacement cannot revive an old session/nonce pair.
- Check active session, signer, revocation, version, current time, `deadlineUnix <= session expiry`, expected nonce, positive amount, and budget before execution.
- Public mode enforces the per-trade cap and gross lifetime spend. Multiple small trades and deposits cannot restore consumed budget. Do checked integer arithmetic.
- `feeCapRaw` is exactly zero for the demo. Network fees/rent come from the separate relayer; do not debit vault funds for retries or tips.

**Done:** owner replacement/revocation works; unauthorized edits, expired intents, stale sessions, replay, cap excess, and cumulative budget excess return stable shared errors.

## M04 Deterministic demo DEX and atomic swap

**Days 4–5; depends on:** M03 and agreed seeded exchange rate.

- Implement `programs/demo-dex/` with funded testSOL reserves and fixed pricing: 100 testUSDC = 1 testSOL. Input `20000000` yields `200000000` output raw units; demo minimum is `198000000`.
- Enforce public `maxSlippageBps=100` against the configured demo rate: `minOutRaw >= ceil(quoteRaw * (10000 - maxSlippageBps) / 10000)` using checked wide arithmetic.
- Implement one typed Aegis adapter instruction that calls only the configured demo DEX. Reject wrong mints, token accounts, adapter ID, route hash, nonzero fees, and unsupported instruction shapes.
- Validate and snapshot input/output token balances; invoke the fixed swap; reload accounts; enforce actual input debit equals approved input and actual output credit meets `minOutRaw`.
- Only advance spent/nonce for a successful swap. Every later failure must roll back transfers and state atomically.
- This fixed-price adapter demonstrates enforcement and CPI integration. It does not demonstrate live market pricing, oracle protection, or production Jupiter routing.

**Done on Day 5:** public-policy smoke test exchanges test assets through a real CPI, then proves an excessive minimum output fails with unchanged balances, spent, and nonce. Alexis can call it through the real IDL.

## M05 Adversarial contract suite

**Days 5–10, regression through Day 20; depends on:** M02–M04.

Own tests under `tests/program/`. Cover valid execution and independently mutate every intent-bound field. Include wrong signer, wrong mint/token program, substituted recipient, duplicate account aliases, wrong adapter/route, zero amount, overflow boundaries, incorrect nonce, expiry boundaries, revocation, and policy-version mismatch.

Use `60000000` input with a fresh `100000000` budget to isolate the per-trade cap failure. Test budget splitting, failed-swap rollback, insufficient reserves, and two requests using the same nonce; at most one succeeds. Test replacement/trade races: a trade before replacement may succeed; afterward the old session must fail. Withdrawal/revocation remain independent of proving services.

Do not count UI validation as contract coverage. Compare confirmed pre/post account state, instruction error codes and logs. Save replayable valid/error transaction examples without distributing owner secrets.

**Done on Day 10:** integrated public core passes, including direct malicious submissions bypassing Alexis's API. No unresolved failure can be explained away by the UI hiding its button.

## M06 Bounded Jupiter feasibility spike

**Initial dependency check on Days 2–3; bounded execution experiment on Days 6–8, maximum two focused days; independent of core completion.**

- Use local-validator fixtures representing a supported real Jupiter route/program dependency set; record fixture provenance and versions. Do not describe a mock devnet DEX as Jupiter.
- Investigate one ExactIn route and exact account/CPI requirements. No arbitrary instruction passthrough or forwarding every API-provided setup/cleanup instruction.
- Evaluate per-trade escrow isolation: fund a trade-specific PDA account with only approved input, expose its authority to the router, validate resulting output, and return residue atomically. Do not pass unrestricted vault authority into arbitrary routing code.
- Record whether loaded fixtures actually execute, account/compute limits, and remaining unsupported pieces. If reproducing the route is infeasible within the timebox, retain a documented spike and ship the fixed demo DEX.

**Done:** a reproducible local result or explicit blocker report; no dependency on live funds and no silent expansion of the main demo scope.

## M07 Conditional private cap verifier

**Days 8–15; depends on:** stable public core and Alexis's circuit/golden vectors.

- Freeze proof serialization, public-input ordering, commitment encoding, circuit/version identity and verification-key hash with Alexis by Day 5, before implementing private-cap execution.
- Session creation selects public or private-cap mode. The agent cannot switch mode, substitute a public limit, omit proof, or fall back after verification failure.
- Bind the committed hidden cap to this exact intent and active policy. Keep the session budget, expiry, nonce, route and asset checks public and enforced as before.
- Verify on-chain using real proof bytes. Reject altered public inputs, tampered proofs, stale versions and reused nonces. Benchmark the verifier and swap together.
- Owner recovery must never require a proof. The commitment alone is not proof of compliance.

**Day 15 gate:** include private mode only when genuine proving, on-chain verification and swap work together with tamper/replay tests. Otherwise disable private mode for the final demo and label ZK as planned; no mock success path.

## M08 Reproducible environments and handoffs

**Initial Day 3; refresh Days 5, 10, 15 and 18.**

Provide localnet start/seed/reset scripts, actual IDL, program IDs, cluster, build revision, test mint addresses/decimals, vault/session accounts, seeded reserves, rate, fixture owner/agent public keys, and policy mode in the deployment manifest. Private keys belong in disposable local development storage, never the published manifest.

Coordinate every IDL change with Alexis and rerun shared smoke tests. Publish devnet only when the fixed fixture is reproducible; retain localnet for the demo fallback. Clearly mark cluster and deployment status. Record upgrade authority and demo trust assumptions; do not claim an audit or immutable deployment without evidence.

**Done:** Alexis can bootstrap and execute one valid and one rejected transaction from the handoff without reading Rust internals.

## M09 Final integration and demonstration evidence

**Days 16–20; depends on:** M05, M08 and optional successful M07.

Freeze ABI, rerun contract regressions, resolve integration defects with Alexis, and rehearse owner deposit → valid trade → malicious request rejection → budget rejection → revoke → blocked trade → owner withdrawal. Use fresh sessions for scenarios that otherwise interfere with each other.

Capture real transaction signatures/logs and before/after balances. Distinguish simulation failures from submitted on-chain failures; deterministic local tests remain labeled as tests. Verify a second clean setup, relayer fee exhaustion behavior, and recovery with backend/prover offline.

**Done on Day 20:** contracts, deployment manifest, IDL, seeded fixtures and demonstration evidence agree. The final demo makes only the guarantees exercised by those artifacts.
