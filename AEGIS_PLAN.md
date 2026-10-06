# Aegis Technical Implementation Plan

Updated: 6 October 2026

Target: a four-week hackathon and investor demo using test assets

Engineers: **Alexi** and **Mariam**

Status: implementation plan; the code paths and commands below are proposed deliverables

Build a Solana vault that executes only authorized swaps even when its agent submits malicious requests. Ship public policy enforcement first. Add one hidden per-trade cap only if the proof, verifier and actual swap work together within the demo schedule.

## 1 Start here

| Person | Primary responsibilities | Independent task file |
| --- | --- | --- |
| Alexi | Shared TypeScript types, SDK, API, agent runner, frontend and end-to-end tests; conditional circuit and prover | [Alexi tasks](docs/planning/ALEXI_TASKS.md) |
| Mariam | Anchor program, vault and session authorization, policy checks, swap adapters, contract tests, deployment; conditional on-chain verifier | [Mariam tasks](docs/planning/MARIAM_TASKS.md) |
| Both | Interface freeze, fixture approval, integration gates and cross-review | [Shared interfaces](docs/planning/INTERFACES.md) |

This is a working allocation by component, not an assumption about either person's existing experience. If ownership is swapped, move the complete workstream and its file ownership together.

**Working rule:** agree on types and fixtures on Day 1, build independently against those contracts, and integrate a small working path by Day 3. Do not wait until the last week to connect the two workstreams.

## 2 Scope and demo policy

### Required baseline

- One vault owner and one active agent session.
- Original SPL Token accounts and two explicitly configured test mints.
- Exact-input swaps in one direction: testUSDC to testSOL.
- Public per-trade cap, session spend budget, session expiry and revocation.
- Fixed input and output vault token accounts; proceeds cannot be redirected.
- On-chain minimum-output enforcement and a deterministic demo price reference.
- Monotonic request nonce and immutable session policy.
- Owner deposit and withdrawal without the agent, API or prover.
- A real devnet program with a clearly labelled test DEX.
- A narrow Jupiter integration experiment using local snapshots and supported routes.
- TypeScript SDK, three UI screens and deterministic malicious-agent scenarios.

### Conditional private-cap extension

- Hide only the per-trade cap.
- Keep session budget, asset pair, slippage setting and executed swap details public.
- Alexi supplies the circuit, prover and proof fixtures.
- Mariam supplies the verifier, deployment binding and atomic proof-plus-swap execution.
- A private-cap vault must never fall back to public-mode execution if proving fails.
- If the extension misses its gates, retain the public-policy demo and label ZK work as a separate prototype.

### Fixed demo configuration

| Setting | Value |
| --- | --- |
| Deposit | 1,000 testUSDC |
| Input decimals | 6 |
| Output decimals | 9 |
| Per-trade cap | 50 testUSDC = `50000000` raw units |
| Session budget | 100 testUSDC = `100000000` raw units |
| Session duration | 3,600 seconds |
| Demo exchange rate | 100 testUSDC = 1 testSOL |
| Public maximum demo slippage | 100 basis points |
| Application fee | Zero; network fees paid from a separate fee-payer account |
| Allowed trade | 20 testUSDC produces 0.2 testSOL at the fixture rate |
| Isolated cap violation | 60 testUSDC: over the cap, but below a fresh session budget |
| Budget exhaustion | Five accepted 20-unit trades; the sixth is rejected |

The fixture rate demonstrates deterministic enforcement. It is not an oracle for a real market. Do not describe the local Jupiter experiment as production price protection.

Excluded from this milestone: arbitrary token support, Token-2022 extensions, arbitrary CPI execution, lending, leverage, multiple simultaneous sessions, hidden cumulative budgets, cross-chain support, billing and social onboarding.

## 3 Ownership and repository layout

Only planning files exist as part of this request. Implement the following structure during the project.

```text
AEGIS_PLAN.md
docs/planning/
  INTERFACES.md                 shared contract; changes require both reviewers
  ALEXI_TASKS.md                Alexi backlog
  MARIAM_TASKS.md                 Mariam backlog
programs/
  aegis/                        Mariam
  demo-dex/                     Mariam
packages/
  types/                        Alexi; Mariam reviews wire-format changes
  sdk/                          Alexi
apps/
  web/                          Alexi
services/
  api/                          Alexi
  agent/                        Alexi
  prover/                       Alexi; conditional ZK
circuits/
  private-cap/                  Alexi; conditional ZK
tests/
  fixtures/                     shared; each fixture has one designated editor
  program/                      Mariam
  e2e/                          Alexi
artifacts/
  idl/                          Mariam generates; never hand-edit
  zk/                           Alexi generates; Mariam verifies
deployments/                     Mariam; no secrets
scripts/
  localnet/                     Mariam
  demo/                         Alexi
```

Mariam owns the Rust lockfile and Anchor configuration. Alexi owns the JavaScript workspace manifest and lockfile. Pin tool versions after the compatibility spike rather than selecting versions independently.

Use separate feature branches such as `feature/alexi-client` and `feature/mariam-program`, merged into `integration/aegis-demo` at each gate. These are proposed branch names; this plan does not create branches. Neither person changes the other's owned implementation without coordination. Interface and fixture changes require both reviewers.

## 4 Architecture and trust boundary

The agent emits a constrained swap request. Alexi's SDK resolves vault state, builds the exact intent and prepares the transaction. Mariam's program checks the active session, policy, nonce, route and actual accounts before signing a swap from a PDA-controlled account.

In private mode, a local prover supplies a proof bound to that exact request. The program reconstructs the proof inputs from the real operation. It does not trust the proof submitter's description of what will execute.

The following are untrusted inputs: model output, API requests, quotes, route payloads, proof envelopes and off-chain preflight results. The final authorization boundary is the on-chain program.

Owner authority can create or replace an agent session and withdraw funds. Agent authority can request supported swaps only. Program upgrade authority is separately documented in the deployment manifest and never described as equivalent to owner-only custody.

PDA signing and CPI privileges must be handled explicitly. [Solana PDA documentation](https://solana.com/docs/core/pda)

## 5 Build independently

### Alexi without Mariam's running program

Implement the `ChainPort` interface from the shared specification with a `MockChainPort`. Use the shared fixtures to model balances, authorization, nonces and stable error identifiers.

Develop the SDK facade, API, agent runner and UI against this port. Every screen must label mock data as mock. The production of a mock receipt is not evidence of blockchain enforcement.

Keep transaction construction behind the port so replacing the mock with `AnchorChainPort` does not change the frontend or agent API.

### Mariam without Alexi's running application

Use Rust tests and local-validator or LiteSVM fixtures to exercise the program directly. Provide a minimal CLI or test script for create, fund, authorize, swap, revoke and withdraw.

Accept the canonical intent fields in the shared specification. Export a generated IDL, deployment manifest and real success/failure examples. Mariam should not need a browser or LLM to prove that authorization works.

### Connect the two

Alexi implements `AnchorChainPort` using Mariam's generated IDL. Run the same semantic fixtures against mock and actual program behavior. Program results decide security outcomes when the two differ.

The critical path is:

`shared interfaces -> vault lifecycle -> first actual swap -> malicious requests -> complete UI flow -> optional ZK -> release evidence`

## 6 Mariam workstream

Detailed tasks: [Mariam tasks](docs/planning/MARIAM_TASKS.md).

1. Establish the Anchor toolchain, local environment, two test mints and deployment manifest.
2. Implement PDA vault authority, owner-controlled token accounts and owner deposit/withdrawal.
3. Implement one active session, immutable policy, expiry, revocation and nonce accounting.
4. Implement exact-input execution through a fixed test-DEX adapter with pre/post balance checks.
5. Reject wrong accounts, extra authority, unsupported routes, replay and cumulative overspending.
6. Export IDL and fixtures for Alexi; support the first real SDK integration.
7. Run a bounded Jupiter CPI experiment using approved instructions and local account snapshots.
8. If the ZK gate passes, integrate the pinned verifier and actual-request proof binding.
9. Deploy the demo, exercise the attack corpus and produce reproducible evidence.

For Jupiter, evaluate per-trade escrow authority funded with exactly the approved input; do not forward full vault authority to arbitrary API instructions. Restrict supported instruction shapes and route legs. Jupiter's current Build API supports raw instructions and CPI-oriented customization. [Jupiter Build](https://developers.jup.ag/docs/swap/build/index)

## 7 Alexi workstream

Detailed tasks: [Alexi tasks](docs/planning/ALEXI_TASKS.md).

1. Publish shared TypeScript types, input validation and a mock implementation.
2. Build a typed SDK with separate prepare and submit operations.
3. Build a local API with bounded requests and explicit execution states.
4. Integrate an agent that can request swaps but cannot change policy or withdraw.
5. Build create-vault, vault-control and activity screens.
6. Connect `AnchorChainPort` to Mariam's program and replace mock paths in the demo.
7. Implement repeatable end-to-end tests and a deterministic malicious-agent mode.
8. If the ZK gate passes, build the private-cap circuit and local prover.
9. Produce the reproducible demo script, measured timings and backup recording.

The LLM receives neither the owner key nor private policy witnesses. Private-key operations stay behind the wallet or local session signer. A secret is never part of a `SwapIntentV1`, `PreparedSwapV1` or API response.

## 8 Shared technical decisions

The authoritative wire formats and handoff requirements are in [Shared interfaces](docs/planning/INTERFACES.md).

Freeze these decisions before independent implementation:

- Raw token units use unsigned integers. JSON uses decimal strings; SDK arithmetic uses `bigint`.
- Solana addresses use base58 at JSON boundaries and 32 decoded bytes in canonical encoding.
- Time is chain Unix time in seconds. Host clock is only a UI estimate.
- Each new owner-authorized session has a fresh identity and invalidates the previous session.
- Policies cannot be edited by an agent. Session replacement is the owner's explicit budget reset.
- Accepted trades increment a monotonic nonce; failed transactions do not consume budget or nonce.
- Output accounts are fixed vault accounts; arbitrary recipients are unsupported.
- Route hashes cover instruction data plus ordered account addresses and privileges.
- Public policy and private-cap mode are distinguished in stored state, not selected by an untrusted trade request.
- Fees and tips cannot be silently extracted from vault balances.
- Error identifiers and transaction states are consistent across program, SDK and UI.

A shared schema is not sufficient by itself: maintain golden serialized bytes and hash vectors in both Rust and TypeScript tests.

## 9 Four-week schedule and integration gates

Days are working days from the agreed project start.

| Gate | Deadline | Alexi delivers | Mariam delivers | Exit condition |
| --- | --- | --- | --- | --- |
| G0 | Day 1 | Types, mock-port skeleton and fixture schema | Account/instruction proposal and manifest schema | Both approve interfaces and encoding order |
| G1 | Day 3 | SDK lifecycle calls using the initial IDL | Running create/fund/session/revoke/withdraw path | One owner lifecycle works through the real SDK |
| G2 | Day 5 | Prepare/submit path and error mapping | Atomic public-policy test-DEX swap | Allowed trade succeeds; 60-unit trade and wrong recipient fail |
| GZ | Day 5 | Small circuit, proof and encoding vectors | Matching hashes and verifier spike | Both decide whether private-cap integration is feasible |
| G3 | Day 10 | UI, agent, activity states and attack harness | Complete baseline checks and devnet deployment | Full public-policy demo works; budget/replay/revoke tests pass |
| G4 | Day 15 | Conditional prover and private-mode UX | Conditional verifier-plus-swap transaction | True private-cap E2E works, or ZK remains explicitly separate |
| G5 | Days 16–20 | E2E report, timings, reset script and video | Program test report, deployment/IDL hashes and Jupiter experiment report | Release checklist passes and demo is repeatable |

During Weeks 1–3, have a short daily interface check: blockers, changed fields and the next handoff. Keep implementation work independent between these checks. Review each integration failure together instead of changing both ends independently.

**Day 5 ZK gate:** one real proof must verify in the target environment, cross-language hash vectors must match, and the team must measure the cost of the intended execution path. If this fails, protect the public-policy schedule.

**Day 15 ZK gate:** only a proof checked in the same atomic operation as the actual swap qualifies as an integrated private-cap demo.

## 10 Acceptance and test ownership

| Test | Mariam | Alexi | Acceptance |
| --- | --- | --- | --- |
| Owner lifecycle | Program and authorization tests | Wallet/SDK E2E | Create, deposit and withdraw work |
| Allowed 20-unit swap | Balance/counter checks | Full request flow | Correct output and budget update |
| 60-unit swap | On-chain cap rejection | Display actual failure | No vault balance or budget change |
| Six 20-unit requests | Cumulative accounting | Sequential harness | Exactly five succeed on a fresh session |
| Concurrent final-budget requests | Writable-state/nonce tests | Concurrent submit harness | No overspend or duplicate execution |
| Replay and expired intent | Contract rejection | Retry/state behavior | No second authorized effect |
| Revoked session | Authorization tests | Revoke followed by swap | Next executed request fails |
| Wrong destination/mint/program | Account/CPI validation | Direct adversarial request | Rejected independently of UI validation |
| Minimum-output failure | Post-CPI rollback | Failure presentation | Balances and counters roll back |
| API/prover outage | Owner exit instruction | Direct SDK withdrawal | Owner control remains available |
| Private proof tampering | Verifier and binding tests | Altered proof/request transport | Changed request cannot reuse a proof |
| Real versus mock execution | Deployment evidence | Mode labels and receipt source | No mock result appears as on-chain proof |

For a private-cap over-limit test, the prover's refusal is only the first result. Also submit an altered request with a proof for an allowed amount and verify that the program rejects it.

Use chain failure evidence or clearly labelled simulation results. A preflight rejection does not create a landed transaction. Network fees may be charged even when vault state rolls back.

Anchor documents program test frameworks including LiteSVM. [Anchor Testing](https://www.anchor-lang.com/docs/testing)

## 11 Environment and release workflow

Use three explicit environments:

1. `mock`: local product development against semantic fixtures.
2. `localnet`: real programs and deterministic tests, including selected Jupiter snapshots where reproducible.
3. `devnet`: real Aegis and test-DEX programs with test assets.

The deployment manifest identifies environment, cluster endpoint, domain identifier, program IDs, mints, token programs, IDL hash, build commit and optional verifier artifacts. It contains no secret key material.

Proposed commands to implement during the project:

| Command | Owner | Purpose |
| --- | --- | --- |
| `pnpm demo:mock` | Alexi | Run the application against fixtures |
| `pnpm demo:reset` | Alexi | Create a fresh isolated demo vault/session |
| `pnpm test:e2e -- --env localnet` | Alexi | Run SDK/application acceptance tests |
| `anchor test` | Mariam | Run contract checks with pinned configuration |
| `scripts/localnet/start` | Mariam | Start the chosen local chain and seeded test programs |
| `scripts/localnet/export-manifest` | Mariam | Write the generated deployment manifest |

Agree on Windows-compatible launch scripts or the same WSL environment on Day 1. These command names are targets, not commands currently available in this workspace.

Before a demo, reset to a fresh vault, validate the manifest, check fee-payer funding, run one success and one contract-level failure, then record the exact program/IDL versions.

## 12 Completion checklist

- [ ] Alexi and Mariam approve the shared interfaces and golden vectors.
- [ ] Each workstream runs independently with its documented commands.
- [ ] The real program and SDK pass G1 and G2.
- [ ] Public-policy lifecycle, atomic swap and attack corpus pass G3.
- [ ] Jupiter results state exactly which route/environment was tested.
- [ ] ZK is either truly integrated at G4 or explicitly labelled a separate prototype.
- [ ] No private witness, owner key or session secret is in logs or manifests.
- [ ] The owner can revoke and withdraw without the agent, API or prover.
- [ ] Final reports include build identity, measured costs and transaction evidence.
- [ ] The demo has a reset procedure and backup recording.
- [ ] No unresolved failure in a required authorization or rollback test remains.

A production launch is a later milestone requiring independent security review, an explicit upgrade-control design, market-price validation and a bounded real-money pilot. Hidden policy parameters do not conceal public swaps or independently solve MEV.
