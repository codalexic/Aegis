# Alexis Client SDK Agent and Prover Tasks

This is a technical assignment for a 20-working-day demo built by Alexis and Mariam. Use test assets only. Alexis can develop against shared fixtures and a mock chain while Mariam builds the programs. Integrate through the contracts in [INTERFACES.md](INTERFACES.md); the overall schedule is in [AEGIS_PLAN.md](../../AEGIS_PLAN.md).

All implementation paths below are proposed. This document does not create implementation files. Planned branches are `feature/alexis-client`, `feature/mariam-program`, and `integration/aegis-demo`; merge at the gates below after both people review compatibility. Pin dependencies only after the initial compatibility spike.

## Ownership and integration rules

Alexis owns `packages/types`, `packages/sdk`, `apps/web`, `services/agent`, `services/api`, `services/prover`, `circuits`, and `tests/e2e`. Mariam owns Rust programs, program tests, and generated IDL. Changes to shared types, encoding, error meanings, or proof inputs require both people's review. Import Mariam's generated IDL; never hand-edit it.

The public fixture is one direction, testUSDC to testSOL, with a 50-unit per-trade cap, 100-unit session budget, and one-hour authorization. Amounts, nonces, policy versions and timestamps use decimal strings on the wire; raw amounts use `bigint` in the SDK. Schema version and basis points use bounded JSON numbers. Timestamps are Unix seconds. Accepted executions advance the nonce; rejected executions do not. Revoked agents cannot execute. Owner withdrawal never requires a prover.

`PreparedSwap` contains the intent, adapter payload, and optional proof, never a signing key. Building and submitting are separate operations. The backend must not blindly relay an arbitrary supplied transaction. Mocks demonstrate application behavior; only program tests or real chain execution establish on-chain enforcement.

## A01 Freeze shared types and fixtures

**Days:** 1–2. **Dependencies:** joint day-1 interface review. **Paths:** `packages/types/src`, `tests/fixtures`.

Implement the frozen interface as TypeScript types and runtime validation. Cover `policyMode` values `public` and `private_cap`, vault/session state, intents, prepared swaps, execution results, and stable `AEGIS_*` errors. Reject malformed raw amounts instead of converting them through JavaScript floating-point numbers.

Use the shared testUSDC/testSOL decimals of 6/9 and fixed demo rate of 100:1. A 20-unit input is `20000000` raw units; expected output is `200000000`, and the 100-basis-point fixture guard permits a `198000000` minimum. Label this trusted test-DEX price configuration explicitly; it is not a market oracle.

Preserve every `SwapIntentV1` field: `version`, `vault`, `session`, `policyVersion`, `nonce`, `deadlineUnix`, `inputMint`, `outputMint`, `amountInRaw`, `minOutRaw`, `inputVaultTokenAccount`, `outputVaultTokenAccount`, `adapterProgramId`, `routeHash`, and `feeCapRaw`. There is no arbitrary recipient field. Agree with Mariam on canonical encoding and hashing before using either in signatures or proofs.

**Acceptance:** both implementations consume identical valid and invalid fixtures; integer precision survives JSON round trips; rejected schemas have stable errors. **Handoff:** exported types, fixture manifest, error catalog, and encoding test vectors reviewed by Mariam.

## A02 Build the SDK and mock chain port

**Days:** 1–3. **Dependencies:** A01 interface baseline. **Paths:** `packages/sdk/src`, `packages/sdk/examples`.

Implement the shared `ChainPort` boundary and a `MockChainPort`. Expose the agreed lifecycle: create vault/session, fund, read state, prepare swap, submit an explicitly signed operation, revoke, and withdraw. Keep wallet/signing dependencies behind adapters so the UI and agent runner can use different authorized signers.

Provide a deterministic mock state and lifecycle CLI. Model balances, expiry, nonce, revocation, and budget sufficiently for application development. Mark every mock result as mock data; do not fabricate explorer links or chain signatures.

**Acceptance:** the mock lifecycle CLI runs independently by Day 2, uses exact amount conversions, and distinguishes owner operations from agent operations. On Day 3, the same SDK surface supports the real lifecycle through the initial A05 adapter. **Handoff:** SDK exports, mock implementation, CLI instructions, and a small integration example.

## A03 Build the agent runner and request API

**Days:** 2–6. **Dependencies:** A01; A02 for chain access. **Paths:** `services/agent/src`, `services/api/src`.

Use one structured trading tool. The agent proposes a permitted pair, amount, and minimum output; application code resolves vault accounts and the approved adapter from trusted configuration. Validate all incoming data. Return a typed prepared request; never accept unrestricted transaction bytes as permission to relay or sign them.

Separate preparation from signing/submission. Keep a delegated agent signer isolated in the local runner, with test permissions only. Never include secrets in API responses, prompts, fixtures, or logs. Add deterministic normal and malicious modes so the presentation does not depend on successfully prompt-injecting a live model.

**Acceptance:** normal mode proposes 20 units; malicious mode proposes an excessive amount or altered protected field. Both requests reach the proper validation/execution path, with precise rejection attribution. **Handoff:** API contract, example requests, runner commands, and signing-boundary notes.

## A04 Build the three screen interface

**Days:** 2–8. **Dependencies:** A01–A02; A03 API incrementally. **Paths:** `apps/web/src`.

Build vault setup, vault management, and activity screens against the mock port first. Setup explains the cap, session budget, pair, and expiry. Management shows actual balances, remaining budget, authorization status, revoke, and withdrawal. Activity distinguishes preparation, wallet rejection, simulation rejection, submission, confirmation, and chain failure.

Label mock mode, devnet test assets, and the test DEX prominently. Show raw technical details behind an expandable view. Require explicit owner wallet authorization for owner actions. Do not require the agent or prover service to be online for withdrawal or revocation.

**Acceptance:** the complete owner flow works with mocks, large amounts remain exact, and every visible success comes from an identified result source. **Handoff:** reproducible UI startup and a short screen walkthrough for Mariam.

## A05 Implement the Anchor chain port and integrate

**Days:** 3–10. **Dependencies:** A01–A02 and Mariam's initial IDL/manifest for the Day 3 lifecycle; A03–A04 and swap fixtures are later incremental dependencies for the complete application. **Paths:** `packages/sdk/src/chain`, `packages/sdk/examples`.

Implement `AnchorChainPort` using the agreed compatible client stack. By Day 3, execute create, fund, create-session, revoke and withdraw through the real SDK without waiting for the UI or agent. Validate the configured network, program IDs, mint addresses, and adapter. Build only supported instructions with explicit accounts. Preserve the distinction between constructing a request and submitting a signed transaction.

Run the day-5 public swap smoke test with Mariam. Investigate interface mismatches together instead of patching inconsistent field interpretations locally. By day 10, switch the complete UI/agent flow from mocks to the actual devnet vault and test DEX.

**Acceptance:** creation, funding, an allowed swap, revocation, and owner withdrawal work end to end. Simulation-only rejection is never displayed as an executed on-chain failure. **Handoff:** working client commands, deployment configuration, transaction evidence, and integration issues resolved or documented.

## A06 Conditional private cap circuit and prover

**Days:** spike by 5; integration through 15 only if approved. **Dependencies:** A01 proof specification and Mariam's verifier interface. **Paths:** `circuits/private-cap`, `services/prover/src`.

Build one circuit proving that the requested input amount is within the committed hidden cap. Follow the jointly agreed amount ranges, salted commitment, request encoding, and public inputs. Bind the proof to the concrete intent and policy identity; do not invent an alternative encoding in the prover.

Keep the cap and salt in a separate local prover service, outside agent prompts, public logs, and on-chain creation arguments. Return a proof for an exact validated request. Measure proving time and exchange matching positive/negative vectors with Mariam.

**Acceptance:** day 5 determines whether to continue; day 15 requires actual proof verification and its corresponding swap in the complete path. Otherwise retain the public-policy demo and identify ZK as a separate prototype. Withdrawal and revocation remain usable with the prover stopped. **Handoff:** circuit, setup provenance, prover command, proof vectors, and measured results; no production-security claim.

## A07 Implement independent end to end acceptance cases

**Days:** 6–12. **Dependencies:** A03–A05; private cases depend on A06. **Paths:** `tests/e2e`.

Use fresh sessions to isolate failure causes. Test an allowed 20-unit swap, a 60-unit request against the 50-unit cap, five accepted 20-unit swaps followed by a sixth budget rejection, replay, expiry, changed output account, wrong adapter, and revoked authorization. Assert balances, nonce, and spent budget before and after each result. Account separately for network fees.

Also reject a requested minimum output below the fixed-rate fixture guard, with the relevant guard error preserved.

Private-mode cases must send altered requests to the contract; a prover refusing to generate a proof is insufficient evidence. Include changed amount and policy identity, and attempts to omit the required proof.

**Acceptance:** failures identify the intended rule and evidence source. **Handoff:** one test command, deterministic inputs, and a result report Mariam can reproduce.

## A08 Harden transaction status and diagnostics

**Days:** 11–16. **Dependencies:** A05–A07. **Paths:** existing SDK, API, and UI modules.

Keep `SimulationRejected` distinct from chain failure, signing rejection, and an unknown submission outcome. Preserve stable `AEGIS_*` codes and relevant signatures. Reconcile chain state before retrying an uncertain submission; never silently sign a changed request or duplicate a swap. Show expired sessions and stale nonces as actionable states.

**Acceptance:** RPC interruption and rejected signing do not create false success, duplicated execution, or misleading balances. Logs expose enough context to diagnose a request without exposing secrets. **Handoff:** status/error mapping and reproducible interruption cases.

## A09 Integrate verify and package the demo

**Days:** 16–20. **Dependencies:** A01–A08, with A06 optional.

With Mariam, merge compatible work into the planned integration branch, run from a clean setup, and repeat the acceptance suite. Freeze the demonstrated configuration. Label local Jupiter fixture results separately from devnet test-DEX transactions and planned functionality.

**Acceptance:** both people can reproduce the three-minute flow: configure and fund, execute an allowed trade, reject a malicious request, revoke, and withdraw. Private-cap claims appear only if the integrated gate passed. **Handoff:** startup instructions, configuration template without secrets, test results, measured timings, evidence links, and a clearly labelled backup recording.
