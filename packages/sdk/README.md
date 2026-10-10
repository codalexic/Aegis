# Aegis SDK

`createClient("mock")` creates an isolated in-memory simulation.
`createClient("localnet")` or `new AnchorAegisClient()` uses the public addresses
in `deployments/localnet.json`. After reseeding, a caller can pass freshly read
JSON as `new AnchorAegisClient({ deployment })`. Only loopback localnet endpoints
and the generated program IDs are accepted in localnet mode.

For devnet, pass the successful deployment manifest explicitly to
`createClient("devnet", { deployment })` or `new AnchorAegisClient({ deployment })`.
Devnet accepts only `https://api.devnet.solana.com` and its matching WebSocket
endpoint. The default connection retries HTTP 429/5xx, transient RPC errors and
network failures up to three times with exponential backoff. A retry resends the
same signed bytes; program rejections are never retried as new transactions.
`explorerTransactionUrl(signature, environment)` selects the correct cluster and
returns no link for mock signatures. For browser wallet signing, see the
[dashboard documentation](../../apps/web/README.md#wallet-owner-signing).

The client holds no wallet and reads no key files. Reads work without a signer;
each write receives its owner or agent `Signer`, which is also the fee payer.
Amounts stay `bigint`; conversion to/from Anchor `BN` uses decimal strings.
Instructions and decoded vault fields are checked against the generated `Aegis`
TypeScript type.

`swapRaw` sends caller-selected accounts with `accountsStrict`, without account
resolution or policy checks. Its only amount validation is the u64 serialization
boundary. Zero, over-cap amounts, wrong signers and redirects reach the program.
Normal `swap` reads stored vault accounts and the configured pool/reserves.

Writes use signed legacy transactions supported by the pinned Anchor/web3.js
stack, a fresh blockhash and confirmation at `confirmed`. Preflight is skipped
deliberately so rejected demo transactions land on localnet, pay test SOL fees
and appear in RPC history. A confirmed rejection returns `origin: "program"`;
a transport/confirmation failure returns `origin: "rpc"`, preserving the signed
transaction's signature where available. Caller input/signing failures return
`origin: "client"`.

`listActivity` reads `getSignaturesForAddress(vault)` and `getTransaction`, with
pagination and `maxSupportedTransactionVersion: 1`. Funding remains a plain SPL
transfer; a readonly vault account reference makes it discoverable in that history.
Withdrawals create the owner's destination ATA idempotently in the same atomic
transaction and do not filter revoked or expired vaults.

`rotateAgent(owner, vault, newAgent)` requires only the owner's signature. It
replaces the agent and clears revocation without resetting spending, cap, budget
or expiry. The default key, owner and current agent are rejected with
`InvalidAmount`; a non-owner signer receives `Unauthorized`. The Anchor client
sends these checks to the program; the mock enforces the same rotation rules.
Rotation is available through the SDK, not the dashboard.

Error names come from the generated IDLs and the failing program's runtime logs.
This matters because Aegis and demo_dex reuse numeric error codes. When logs are
unavailable, unknown custom codes stay `CustomProgramError(n)`; the client never
guesses a program error name or treats a confirmed rejection as success.

```bash
pnpm test:sdk
pnpm --filter @aegis/sdk typecheck
```

SDK unit tests use real IDL encoding, decoding and transaction signing against
stubbed RPC methods. They require no keys on disk, validator or generated build
output. The [localnet end-to-end suite](../../tests/e2e/README.md) exercises the
client against deployed programs.
