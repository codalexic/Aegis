# Aegis Shared Technical Interfaces

Owners: Alexi and Mariam

Status: proposed version 1 contract to approve on Day 1

Scope: test-asset demo; public-policy baseline with a conditional private-cap extension

This specification is the boundary between Alexi's TypeScript application and Mariam's Solana programs. It defines proposed interfaces; it does not imply that any implementation or deployed address already exists. [Main plan](../../AEGIS_PLAN.md)

## 1 Ownership and change control

Alexi implements TypeScript types, runtime validation, SDK ports and serialization. Mariam implements the corresponding Rust types, account checks, instructions and errors. Both approve canonical bytes, hashes and fixture outputs.

Freeze baseline fields on Day 1. Record any change in this document and update both fixture consumers in the same integration change. Do not independently rename fields or reinterpret units. Export the actual generated IDL; never maintain a handwritten substitute after the program exists.

The private-cap design in section 10 is a candidate until the Day 5 cross-language proof gate passes. Pin exact library versions and proof conversion rules in its artifact manifest. No integrated ZK claim is permitted before the full execution gate.

## 2 Primitive types and validation

| Type | JSON | SDK and program rules |
| --- | --- | --- |
| Address | Base58 string | Decode to exactly 32 bytes; do not hash its textual representation |
| Raw amount | Unsigned decimal string | Canonical digits, no sign/exponent/fraction; at most u64; SDK uses bigint |
| Nonce and version | Unsigned decimal string | u64; checked increments; no wraparound |
| Unix time | Unsigned decimal string | Seconds; reject values outside the agreed nonnegative i64 range |
| Basis points | JSON integer | u16 with semantic range 0 through 10000 |
| Hash | 64 lowercase hexadecimal characters | Exactly 32 bytes |
| Byte payload | Base64 string | Strict decoder and bounded byte length |
| Policy mode | public or private_cap | Chosen in owner-authorized session creation; read from chain at execution |

Use zero only where the field permits it. Swap input and minimum output must be positive. All calculations use checked integer arithmetic; wide intermediate products use u128 or equivalent. Never pass token amounts through JavaScript Number.

Chain time is authoritative. Client time can suggest a deadline but cannot validate authorization. Require `chainTime < deadlineUnix <= sessionExpiryUnix`.

Amounts are denominated in the configured input token's base units. A cap of `50000000` for a six-decimal test token means 50 test tokens, not a universal USD limit.

## 3 Account and session model

Proposed PDA seeds, frozen at G0:

| Account | Seeds under the Aegis program |
| --- | --- |
| Deployment config | ASCII `config` |
| Vault state | ASCII `vault`, owner pubkey bytes, vaultId as u64 little-endian |
| Vault authority | ASCII `authority`, vault state pubkey bytes |
| Session | ASCII `session`, vault state pubkey bytes, generation as u64 little-endian |
| Optional trade authority | ASCII `trade`, session pubkey bytes, nonce as u64 little-endian |

Use canonical PDA bumps. The fixed input and output token accounts are associated token accounts of the vault authority for the configured original SPL Token program and exact mints. The program validates all derivations and token account relationships; client derivation alone is insufficient.

Vault state contains owner, vaultId, token pair, authority bump, active session, next session generation and next policy version. A session contains agent pubkey, immutable policy, expiry, spent input amount, expected nonce and revocation state.

Only the owner may create or replace a session. Generation and policy version increase on replacement and are never reused. Replacement invalidates the old active session even if its account remains on-chain. Nonce begins at zero for each unique session and advances only after successful execution. The session address prevents cross-session replay.

Revocation is effective in chain execution order: an already executed trade is not undone. A trade executed after confirmed revocation or replacement must fail. Withdrawals do not reset spent budget. Deposits do not reset spent budget. Only a new owner-authorized session grants a fresh budget.

Owner withdrawal transfers the selected supported asset from its vault account to the owner's corresponding token account. It requires the owner signature and no proof or agent service. The agent has no withdrawal, token-delegate, authority-change or account-close instruction.

## 4 Public DTOs

The following snippets describe exported TypeScript contracts. Runtime validators must enforce their numerical and address constraints.

```ts
type Address = string;
type U64String = string;
type UnixSeconds = string;
type Hex32 = string;
type Base64Bytes = string;

type PolicyV1 = {
  sessionBudgetRaw: U64String;
  expiryUnix: UnixSeconds;
  inputMint: Address;
  outputMint: Address;
  adapterProgramId: Address;
  maxSlippageBps: number;
  feeCapRaw: "0";
} & (
  | { policyMode: "public"; maxTradeRaw: U64String }
  | {
      policyMode: "private_cap";
      policyCommitment: Hex32;
      circuitId: "aegis-private-cap-v1";
    }
);

interface SwapIntentV1 {
  version: 1;
  vault: Address;
  session: Address;
  policyVersion: U64String;
  nonce: U64String;
  deadlineUnix: UnixSeconds;
  inputMint: Address;
  outputMint: Address;
  amountInRaw: U64String;
  minOutRaw: U64String;
  inputVaultTokenAccount: Address;
  outputVaultTokenAccount: Address;
  adapterProgramId: Address;
  routeHash: Hex32;
  feeCapRaw: "0";
}

interface AccountMetaV1 {
  address: Address;
  isSigner: boolean;
  isWritable: boolean;
}

interface AdapterPayloadV1 {
  adapterKind: "demo_dex_v1" | "jupiter_local_experiment_v1";
  instructionDataBase64: Base64Bytes;
  accounts: AccountMetaV1[];
}

interface ProofEnvelopeV1 {
  circuitId: "aegis-private-cap-v1";
  verifyingKeyHash: Hex32;
  proofEncoding: "groth16-solana-v1";
  proofBase64: Base64Bytes;
  publicInputsBeHex: [Hex32, Hex32, Hex32]; // C, amount, B
}

interface PreparedSwapV1 {
  intent: SwapIntentV1;
  adapter: AdapterPayloadV1;
  intentHash: Hex32;
  proof?: ProofEnvelopeV1;
}
```

`proofEncoding` names the team's versioned adapter format; it is not a claim that libraries share a universal serialization. Freeze its actual byte layout with a valid proof fixture before private mode is enabled.

The stored session selects allowed adapter kind and mode. A request cannot enable the Jupiter experiment on a test-DEX session or downgrade private mode. The local Jupiter experiment is not a generally available routing endpoint.

There is no arbitrary recipient. Both token accounts must match the vault's accounts. Program ID, deployment domain, policy values and agent authorization are resolved from verified deployment and account state, not accepted as authority from DTO fields.

Use the name `PreparedSwapV1` in exported types; `PreparedSwap` in task prose refers to this type. It contains neither a secret key nor a partially trusted arbitrary transaction to sign blindly.

## 5 Canonical bytes and route hashing

Never hash JSON. Use fixed ordering and fixed-width binary encodings.

`intentHash = SHA256(intentBytes)` where `intentBytes` concatenates:

1. ASCII `AEGIS_SWAP_V1`, without a null terminator or length prefix.
2. `version` as one byte, equal to 1.
3. The 32-byte deployment domain from the program's deployment config.
4. The executing Aegis program ID, decoded to 32 bytes.
5. `vault`, `session`, each 32 bytes.
6. `policyVersion`, `nonce`, `deadlineUnix`, each u64 little-endian.
7. `inputMint`, `outputMint`, each 32 bytes.
8. `amountInRaw`, `minOutRaw`, each u64 little-endian.
9. `inputVaultTokenAccount`, `outputVaultTokenAccount`, `adapterProgramId`, each 32 bytes.
10. `routeHash`, exactly 32 bytes.
11. `feeCapRaw`, u64 little-endian, zero for this demo.

The deployment domain is initialized as part of trusted deployment configuration and included in the manifest. An agent cannot supply or change it. Mariam and Alexi verify that the manifest matches actual on-chain configuration.

`routeHash = SHA256(routeBytes)` where `routeBytes` concatenates:

1. ASCII `AEGIS_ROUTE_V1`, without a terminator or length prefix.
2. The actual called adapter program ID, 32 bytes.
3. Instruction-data length as u32 little-endian, then the exact instruction bytes.
4. Number of account metas as u32 little-endian.
5. For every account in exact CPI order: pubkey bytes, one byte for `isSigner`, one byte for `isWritable`.

Flag bytes are exactly 0 or 1. Define and enforce maximum payload size/account count from the chosen adapter during G0; no unbounded allocation from input lengths. Reject unsupported account aliases and privilege requests.

The program reconstructs and hashes the exact CPI it will perform. It compares the result to the intent. A caller-supplied digest cannot stand in for validating the instruction bytes, actual account keys and permitted privileges. Hash the constructed CPI AccountMeta flags, including approved PDA signing privileges, rather than copying outer-transaction AccountInfo flags. Derived PDA signing privileges must match the approved adapter's account model.

Alexi and Mariam independently serialize the same fixture. Store canonical byte hex, route hash and intent hash in `tests/fixtures`. Any field mutation must either fail validation or change the expected hash.

## 6 Program instructions and SDK surface

| SDK operation | On-chain responsibility | Signer |
| --- | --- | --- |
| createVault | Initialize owner-bound vault and supported accounts | Owner |
| deposit | Move supported input tokens into the vault | Depositor with source authority; demo uses owner |
| createSession | Set fresh active generation, agent and immutable policy | Owner |
| getVaultState | Read and validate vault/session/token accounts; no write instruction | None |
| prepareSwap | Read state, construct exact supported operation; no spend | None |
| submitPreparedSwap | Authorize exact intent, check policy, execute atomic swap | Authorized agent plus fee payer as needed |
| revokeAgent | Mark session revoked or remove active authorization | Owner |
| withdraw | Transfer supported vault assets back to owner | Owner |

The public-policy execution and private-cap execution may be separate Anchor instructions, but both must check the stored mode. The public entry point rejects private sessions. No generic `executeArbitraryInstruction` exists.

Program validation order should produce predictable fixture errors: account and authorization checks; active session/version/time/nonce; supported assets/route/fees; public cap or private proof; cumulative budget; reference-price guard; CPI and postconditions. Define exact numeric Anchor errors in generated artifacts before G2.

The program enforces `actualInputDebit == amountInRaw` and `actualOutputCredit >= minOutRaw`. It must reload accounts after CPI and verify their authorities and supported semantics. Nonce/spend updates and all transfers form one atomic operation. Failed execution does not consume nonce or budget; network fees are separate.

## 7 Chain port and service boundary

```ts
interface ChainPort {
  getVaultState(vault: Address): Promise<VaultSnapshotV1>;
  prepareSwap(request: SwapRequestV1): Promise<PreparedSwapV1>;
  submitPreparedSwap(
    prepared: PreparedSwapV1,
    signer: LocalSignerHandle,
  ): Promise<ExecutionReceiptV1>;
  prepareOwnerAction(action: OwnerActionV1): Promise<WalletSignableV1>;
  getExecution(operationId: string): Promise<ExecutionReceiptV1>;
}
```

The auxiliary types are defined by Alexi under the same shared review. `VaultSnapshotV1` includes owner, active session, agent, policy, balances, spent amount, expected nonce, chain time and source environment. `SwapRequestV1` contains a vault, supported pair, amount and requested minimum output; it does not grant arbitrary account selection.

`OwnerActionV1` covers create/fund/create-session/revoke/withdraw. `LocalSignerHandle` is an in-process wallet or signer adapter, never a JSON private key. `WalletSignableV1` is built from allowlisted instructions and inspected before wallet authorization.

Implement `MockChainPort` first and `AnchorChainPort` against the real IDL. Both satisfy the same semantic tests. Keep the port injectable into the SDK and application rather than scattering environment branches through every screen.

Proposed API boundaries:

| Endpoint | Input and result |
| --- | --- |
| GET /v1/vaults/:vault | Validated snapshot with source environment |
| POST /v1/swaps/prepare | Supported request to exact PreparedSwapV1 |
| POST /v1/swaps/submit | Prepared operation reference, bound session authorization and local signer dispatch |
| GET /v1/executions/:operationId | Actual execution state and available evidence |
| POST /v1/proofs/private-cap | Local-only prover request referencing an exact prepared intent and private policy handle |

The submit service revalidates state and the exact operation. It never accepts arbitrary bytes as permission to sign. Submission authentication and quotas are service defenses; the program independently requires the session agent signature.

Owner actions can be built through the SDK directly and signed by the owner's wallet without the API/prover. A private policy handle resolves cap/salt only inside the local prover. Public API and LLM messages never carry those witness values.

## 8 Execution states and errors

`ExecutionReceiptV1` carries operation ID, environment (`mock`, `localnet`, `devnet`), intent hash, status, stable error when applicable, and a real signature only if one exists. Capture pre/post vault amounts for reproducible tests without pretending a client snapshot is finalized chain evidence.

| Status | Meaning |
| --- | --- |
| Prepared | Exact request built; nothing submitted |
| AwaitingSignature | Waiting for an actual signer |
| SigningRejected | Signer declined; nothing submitted |
| SimulationRejected | Preflight or explicit simulation failed; no landed failure implied |
| Submitted | A transaction was sent; outcome not yet established |
| Confirmed | Required confirmation observed without program error |
| Finalized | Finalized successful execution observed |
| ChainFailed | A submitted transaction has a chain execution error |
| UnknownOutcome | Submission/confirmation uncertain; reconcile before retrying |
| Expired | Intent or transaction validity expired without an established successful result |

Preserve already observed signatures during uncertainty. After an unknown outcome, inspect signature status and session nonce/state before resubmission. A new blockhash may wrap the same intent; do not silently create a new nonce or changed trade and call that a retry. Rebuild a proof if any bound intent field changes.

Stable semantic error identifiers:

| Identifier | Meaning |
| --- | --- |
| AEGIS_INVALID_REQUEST | Malformed encoding, unsupported version or out-of-range value |
| AEGIS_OWNER_REQUIRED | Missing owner authorization |
| AEGIS_AGENT_UNAUTHORIZED | Wrong agent signer |
| AEGIS_SESSION_INACTIVE | Revoked, replaced or inactive session |
| AEGIS_SESSION_EXPIRED | Chain time exceeds active session validity |
| AEGIS_INTENT_EXPIRED | Request deadline invalid or passed |
| AEGIS_POLICY_MISMATCH | Wrong policy version or stored mode |
| AEGIS_NONCE_MISMATCH | Stale, repeated or out-of-order request |
| AEGIS_CAP_EXCEEDED | Public per-trade cap exceeded |
| AEGIS_BUDGET_EXCEEDED | Session cumulative budget insufficient |
| AEGIS_ACCOUNT_MISMATCH | Wrong mint, token account, authority or fixed destination |
| AEGIS_ROUTE_UNSUPPORTED | Wrong adapter, hash, instruction shape or route |
| AEGIS_FEE_UNSUPPORTED | Nonzero or unsupported demo fee |
| AEGIS_MIN_OUT_TOO_LOW | Requested threshold weakens the configured price guard |
| AEGIS_MIN_OUT_NOT_MET | Actual output fails the required minimum |
| AEGIS_PROOF_REQUIRED | Private session without its proof |
| AEGIS_PROOF_INVALID | Proof or request binding does not verify |
| AEGIS_INSUFFICIENT_FUNDS | Insufficient supported input balance |

Alexi maps numeric program codes using Mariam's generated IDL. Raw RPC/DEX failures that cannot be mapped retain their original cause and origin; do not guess an Aegis error. Private-mode verification failure is `AEGIS_PROOF_INVALID`, not evidence that a specific hidden limit was exceeded.

## 9 Shared test fixtures

Store semantic fixtures in `tests/fixtures`; TypeScript packages consume these rather than maintaining divergent copies. Generated deployment addresses are supplied through a manifest. Use actual deterministic test keys when generating byte/hash vectors, not symbolic placeholders inside serialized data.

| Fixture | Setup | Expected result |
| --- | --- | --- |
| allowed20 | Fresh 50-cap/100-budget session; input 20000000; minOut 198000000 | Output 200000000; spent 20000000; nonce 1 |
| cap60 | Fresh session; input 60000000 | Public AEGIS_CAP_EXCEEDED |
| budgetSixth | Five accepted 20000000 swaps, then a sixth | AEGIS_BUDGET_EXCEEDED |
| replay | Resubmit the accepted nonce | AEGIS_NONCE_MISMATCH |
| redirected | Replace output vault token account | AEGIS_ACCOUNT_MISMATCH |
| weakMinimum | Request minOut below 198000000 for the 20-unit fixture | AEGIS_MIN_OUT_TOO_LOW |
| impossibleMinimum | Request minOut 201000000 for a 200000000-output swap | Fails with no transfer or state change; attribute actual failure origin |
| revoked | Confirm revocation, then execute | AEGIS_SESSION_INACTIVE |
| oldSession | Owner replaces active session, then submits old request | AEGIS_SESSION_INACTIVE |
| outageExit | Stop API, agent and prover; owner uses direct SDK | Withdrawal succeeds |
| tamperedPrivate | Modify a bound field of an allowed proof/request | Private execution rejected |

Fixture rate: input has 6 decimals and output has 9. Compute `quoteRaw = floor(amountInRaw * 1000000000 / (100 * 1000000))`. With `maxSlippageBps = 100`, enforce `minOutRaw >= ceil(quoteRaw * 9900 / 10000)` and positive values. Use checked wide intermediates.

The test DEX has funded output reserves. An independently imposed excessive minimum and an underfunded DEX are separate failure cases. Add a contract test for any reachable post-CPI failure to establish rollback instead of relying only on preflight rejection.

Use chain-relative expiry when generating devnet fixtures. For local deterministic tests, explicitly set the test clock and record it in the fixture. Test times are not assumptions about the host's current date.

## 10 Conditional private cap proof boundary

Candidate: Groth16 over BN254, with matching Circom/snarkjs and Solana verifier tooling. The existing library is a starting point, not a security assessment of this design. [Groth16 Solana](https://github.com/Lightprotocol/groth16-solana)

The goal is a small proof with three public signals that binds a hidden cap to the actual trade without computing SHA-256 inside the circuit.

```text
Public inputs in exact order: C, a, B
Private witness: cap, salt, h0, h1

C = Poseidon3(D_POLICY, cap, salt)
H = SHA256(canonical intent bytes)              computed outside the circuit
h0 = big-endian integer from H bytes 0..15
h1 = big-endian integer from H bytes 16..31
B = Poseidon5(D_BIND, C, a, h0, h1)

Circuit constraints:
  0 < a <= cap < 2^64
  0 <= salt < 2^128
  0 <= h0, h1 < 2^128
  recomputed C equals the public C
  recomputed B equals the public B
```

Generate `salt` with a cryptographically secure random generator. Define `D_POLICY` as the big-endian integer represented by ASCII `AEGIS_POLICY_V1` and `D_BIND` from ASCII `AEGIS_BIND_V1`; both must be validated as distinct in-field constants.

Use the exact same Poseidon BN254 x^5 parameters and input ordering in TypeScript, Rust and the circuit. Do not substitute Poseidon2. The documented Solana Poseidon parameters include BN254 x^5; cross-language compatibility must still be established with golden vectors. [Solana Poseidon parameters](https://docs.rs/solana-poseidon/latest/solana_poseidon/enum.Parameters.html)

All public signals are canonical 32-byte big-endian field elements in the declared order; reject values outside the field rather than silently reducing them. Amount and hash-limb ranges must be actual circuit constraints. A declared but unused public input does not establish binding.

Mariam's program reads C from the active owner-approved policy, reconstructs H from actual execution accounts/data, derives h0/h1 and B, then verifies `[C, actualAmount, B]`. Values in `publicInputsBeHex` are useful for transport consistency checks but do not replace on-chain reconstruction.

The circuit constrains B using its private digest limbs. A proof for a different request will have a different binding under the chosen hash assumptions. The session agent signature is still required; policy compliance alone does not authorize a caller.

The verifier key is pinned to the supported circuit and build. The request's `verifyingKeyHash` is checked against that known key; it cannot select an arbitrary key. Alexi supplies a conversion function from snarkjs output to the pinned verifier's exact point/byte format, and Mariam verifies it against a known positive proof and corruption tests. Do not copy a proof layout from an unrelated verifier.

Day 5 private-cap handoff must contain:

- Circuit source and compiler/library versions.
- Canonical request bytes, SHA-256 digest and two 128-bit limbs.
- Commitment C, amount a and binding B, as scalar values and verifier bytes.
- A valid proof and tampered amount/vault/session/nonce/route variants.
- Circuit, proving-key and verifying-key checksums and setup provenance.
- Measured prover time and on-chain verifier resource usage.
- An agreed path to fit proof checking and swap into one atomic transaction.

Groth16 setup and artifacts are demo-specific and must be identified as such. Do not reuse an unreviewed demo setup as a production assurance. [snarkjs documentation](https://github.com/iden3/snarkjs)

Public observers still see swap amounts, assets and activity, and may infer bounds. The prover knows the cap and salt. Use a fresh private demo policy instead of claiming to hide a cap already published in an earlier public session.

## 11 Deployment manifest and integration handoffs

Mariam publishes `deployments/<environment>.json` with:

- Schema version, environment, cluster endpoint and chain genesis identity.
- Aegis program ID, config address and deployment domain.
- Test-DEX program ID and supported adapter kind.
- Original token program, input/output mint addresses and decimals.
- Build commit, generated IDL location and hash.
- Public fixture owner/agent identities, seeded vault/session and fixture rate.
- Upgrade authority public identity and deployment status.
- Optional circuit ID, verification-key hash and proof encoding version.

Never publish private keys, cap/salt witnesses or credentials. An authenticated RPC URL containing a key belongs in local configuration, not the committed manifest. Record a redacted endpoint or environment-variable reference instead.

Alexi's handoff includes the typed SDK exports, ChainPort conformance tests, API examples, execution-state mapping, UI startup and E2E commands. Mariam's handoff includes generated IDL, account derivation examples, localnet setup, real accepted/rejected transactions and program tests.

Use progressively stronger checks at the integration gates:

1. At G0, approve schemas, account derivations and canonical encoding order; define the golden fixtures. A live deployment is not required.
2. By G1, run the baseline encoding/hash vectors in Rust and TypeScript, validate the initial manifest/IDL against the deployed program, and run create/fund/session/read/revoke/withdraw through the real SDK.
3. From G2 onward, also run one accepted swap and one direct contract-level rejection; compare balances, nonce, policy version and spent budget.
4. At GZ and G4, add the cross-language proof fixtures and then atomic proof-plus-swap acceptance respectively.
5. At each applicable gate, record environment, build identity, actual evidence and remaining unsupported paths. Repeat previous passing checks when interfaces or dependent implementation change.

Keep mock, localnet and devnet evidence separate. A local Jupiter fixture result does not establish devnet Jupiter liquidity, arbitrary-route support or live market-price safety.
