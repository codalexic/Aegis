# Alexis Four Day SDK Dashboard and Agent Plan

Alexis owns the client work; Mariam owns the contracts, fixed test DEX, generated IDL, and deployment. This assignment is **four working days, eight hours per day: 32 hours including integration and contingency**. Use test assets only. This is a plan; implementation files do not exist because of this document.

Follow [INTERFACES.md](INTERFACES.md) and [AEGIS_PLAN.md](../../AEGIS_PLAN.md). Alexis owns `packages/sdk`, `apps/web`, `scripts/agent`, `scripts/demo`, and `tests/e2e`. Both approve shared `tests/fixtures`; Mariam generates the IDL. Build one thin SDK module, one dashboard, and one local agent script. Do not create a separate types package, general REST service, indexer, or complete chain emulator.

ZK, circuits, provers, Jupiter integration, and Blinks are deferred until after the demo. Do not implement new cryptography. An LLM is optional only after the required flow passes; deterministic actions remain the demo path.

## Shared baseline

The immutable public policy belongs to one vault: owner, delegated agent, fixed input/output mints, cap `50000000`, budget `100000000`, one-hour expiry, and `maxSlippageBps=100`. A reset or new authorization creates a new vault. There is no session replacement.

Implement the IDL-backed operations `create_vault`, `deposit`, `revoke_agent`, `withdraw`, and `execute_swap(amountInRaw, minOutRaw, expectedNonce, deadlineUnix)`. Resolve fixed accounts using Mariam's documented derivations. No route hash, generic instruction execution, proof envelope, or arbitrary destination belongs in the baseline.

testUSDC has six decimals; testSOL has nine. The test DEX rate is 100:1: input `20000000` yields output `200000000`, with minimum `198000000`. Amounts, nonce, and expiry use decimal strings in JSON. Use `bigint` arithmetic and checked bounds; never convert token amounts through JavaScript `Number`. Chain time determines validity.

## A01 Freeze fixtures and client boundary

**Day 1: 2 hours. Dependency:** joint interface review. **Paths:** `packages/sdk`, `tests/fixtures`.

Agree the account map, wire conversions, errors, local signer boundary, and minimal deployment manifest with Mariam. Add shared fixtures for allowed 20, excessive 60, and cumulative budget exhaustion. Freeze the exact immutable-policy arguments and expiry/deadline semantics.

Define a small injectable port for read, build, sign/submit, and receipt lookup. Provide static mock results sufficient to scaffold the dashboard; label them as mocks.

**Completion/handoff:** agreed types, numerical fixtures, and a minimal mock. Mariam can confirm the same raw amounts and expected outcomes without reading frontend code.

## A02 Scaffold dashboard and connect initial lifecycle

**Day 1: 6 hours. Dependencies:** A01; Mariam's initial IDL and running lifecycle by the final Day-1 integration block. **Paths:** `packages/sdk`, `apps/web`.

Create one dashboard with setup, balances/actions, and activity sections. Use mock fixtures briefly, then implement the initial Anchor adapter for vault creation, reading state, and funding. Keep transaction construction separate from signing/submission. Build only the supported instructions and inspect configured program/mint addresses.

The browser wallet signs owner actions. Secrets never enter DTOs, logs, manifests, or the frontend bundle. Label `mock`, `localnet`, and `devnet` explicitly.

**Completion/handoff:** by end Day 1, real SDK lifecycle calls use Mariam's IDL; dashboard structure exists. Share a reproducible create/read/fund command and actual configuration.

## A03 Complete owner control and real swap

**Day 2: 8 hours, including one shared deployment hour. Dependencies:** A02; Mariam's revoke/withdraw and fixed-DEX handoffs. **Paths:** `packages/sdk`, `scripts/demo`.

Integrate revoke and owner withdrawal by noon. Both work directly through the SDK and owner wallet with the agent stopped; no application backend is required. Build the exact-input swap and validate current nonce, deadline, fixed accounts, and requested minimum.

By end Day 2, execute the 20-unit swap through the actual program and test DEX. Coordinate one hour with Mariam to attempt devnet deployment/integration. If blocked when that hour ends, continue on the real local chain and prepare a clearly labelled recorded fallback.

**Completion/handoff:** successful swap receipt and before/after balances; owner recovery demonstrated; direct 60-unit cap and substituted-destination smoke rejections with unchanged state; reproducible commands and environment decision. The broader attack suite follows on Day 3.

## A04 Finish dashboard and deterministic agent

**Day 3 morning: 4 hours. Dependencies:** A03. **Paths:** `apps/web`, `scripts/agent`.

Complete balances, remaining budget, nonce, expiry, revoke, withdrawal, and activity. The local Node agent loads only its delegated test key from local secret storage. Provide deterministic valid-20 and malicious-60 modes; never expose the owner key to the agent.

The script emits non-secret receipt JSON. The dashboard may import that receipt and verify its signature/status via RPC, then refresh balances. Importing JSON alone is not chain evidence. This avoids building a service to connect the script and UI.

**Completion/handoff:** dashboard and both agent scenarios work by noon. Share launch commands and supported receipt states.

## A05 Verify attacks and freeze features

**Day 3 afternoon: 4 hours. Dependencies:** A03–A04. **Paths:** `tests/e2e`, `scripts/demo`.

Use fresh vaults to isolate cases: 60 against a fresh 100 budget; five accepted 20-unit swaps and a sixth rejection; replay; revoked agent; changed destination; weak minimum output. Assert balances, nonce, and spent budget. Submit adversarial cases directly to the program rather than counting UI rejection as enforcement.

Distinguish `SimulationRejected`, landed chain failure, signing rejection, and unknown outcome. Preserve signatures and reconcile before retrying. Attribute network fees separately from vault state.

**Completion/handoff:** core tests pass; unresolved defects are recorded with Mariam. Freeze features at end Day 3.

## A06 Rehearse record and absorb integration failures

**Day 4: 8 hours: four planned, four contingency. Dependencies:** A05.

Reproduce setup from clean instructions, create fresh vaults, rerun acceptance tests, and rehearse setup/fund → allowed swap → blocked malicious request → revoke → blocked trade → owner withdrawal. Record the exact environment, program/IDL identity, signatures or labelled test results, balances, and measured timings.

**Completion/handoff:** working launch/reset instructions, acceptance report, and clearly labelled backup recording. Spend contingency on defects, deployment, or recording; add no deferred features. Deliver only claims demonstrated by the real program.
