# Roadmap: from devnet to a production protocol

Aegis today is a working Solana program that enforces spending limits on AI
agents: per-trade cap, total budget, expiry, revocation and a fixed output
destination, with owner withdrawal always available. It is live on devnet at
[aegis.axssell.com](https://aegis.axssell.com), backed by more than 1,000
automated tests.

This roadmap describes how Aegis becomes a production protocol that any agent
on Solana can trade through safely. Each phase lists what ships and the
criteria that must hold before moving on.

| Phase | Focus | Outcome |
| --- | --- | --- |
| 1 | Harden the core | Fuzzed, invariant-tested, upgradeable vault accounts |
| 2 | Real markets | Jupiter swaps, USD-denominated limits, multi-token vaults |
| 3 | Policy engine v2 | Rolling budgets, allowlists, multiple agents, multisig owners |
| 4 | Security and operations | Audits, multisig upgrades, verified builds, monitoring |
| 5 | Developer platform | Published SDK and plug-ins for popular agent frameworks |
| 6 | Mainnet launch | Gated beta with TVL caps, then public mainnet |
| 7 | Private policies | Confidential balances and zero-knowledge policy proofs |

## Phase 1: Harden the core

The guarantees Aegis makes must hold for every possible input, not just the
tested ones.

- **Fuzzing.** Run [Trident](https://github.com/Ackee-Blockchain/trident) against
  every instruction with random amounts, signers, account substitutions and
  instruction orderings.
- **Invariants**, checked after every fuzzed step:
  - spent never exceeds the budget;
  - funds leave the vault only through a swap into the vault's own output
    account, or through owner withdrawal;
  - owner withdrawal always succeeds, including after revocation and expiry;
  - a revoked or expired vault never executes a swap.
- **Events.** Emit Anchor events for vault creation, swaps, revocation, rotation
  and withdrawal, so indexers and alerting can follow every vault.
- **Upgradeable accounts.** Add a version field and reserved space to the vault
  account so future policies can migrate existing vaults without redeploying funds.

**Exit criteria:** 24 hours of fuzzing with no invariant violations, and the
invariants published in a security document.

## Phase 2: Real markets

- **Jupiter integration.** Replace the demonstration exchange with a CPI into
  Jupiter. The vault validates the route's input and output mints and token
  accounts and enforces a minimum output and a slippage bound, so the "fixed
  destination" guarantee carries over to real liquidity. Address lookup tables
  keep routes within transaction size limits.
- **Value-based limits.** Denominate cap and budget in USD using
  [Pyth](https://pyth.network) price feeds, with staleness and confidence checks,
  so one limit holds across every token the agent touches.
- **Multi-token vaults.** Owners choose which tokens the agent may sell and buy;
  anything outside the allowlist is rejected on-chain.

**Exit criteria:** a mainnet-fork test suite swaps through Jupiter under every
policy rule, including manipulated prices and hostile routes.

## Phase 3: Policy engine v2

- **Time-based budgets:** rolling daily or weekly limits that reset on chain time.
- **Per-token caps** and a **cooldown** between trades.
- **Allowlists** of programs and counterparties the agent may interact with.
- **Pause and resume** for owners, alongside permanent revocation.
- **Multiple agents per vault**, each with its own limits, and short-lived
  **session keys** so a leaked agent key expires on its own.
- **Multisig owners** through [Squads](https://squads.so), for team and treasury vaults.

**Exit criteria:** every rule ships with program tests and a dedicated attack test.

## Phase 4: Security and operations

- **Two independent audits** from established Solana security firms, followed
  by a public bug bounty.
- **Upgrade authority** moved to a Squads multisig with a timelock.
- **Verified builds** with `solana-verify`, so anyone can match the on-chain
  binary to this repository.
- **Agent key custody** in a KMS or MPC signer instead of an environment variable.
- **Monitoring and alerts:** an indexer on top of the program events, alerts to
  owners on blocked attempts, low budget and upcoming expiry, and an incident runbook.
- **Infrastructure:** paid RPC with automatic failover and a durable rate-limit store.

**Exit criteria:** all high and critical audit findings closed, and program
upgrades controlled by the multisig.

## Phase 5: Developer platform

- **`@aegis/sdk` on npm**, with typed clients, examples and API documentation.
- **Plug-ins for agent frameworks:** Solana Agent Kit, ElizaOS, and an MCP server
  so any LLM with tool use can trade through a vault.
- **Solana Actions and Blinks** for owner controls (create, fund, revoke,
  withdraw), already live and kept current.
- **Owner dashboard** for many vaults at once, with email and Telegram notifications.

**Exit criteria:** an external developer connects an existing agent to an Aegis
vault in under ten minutes using only the public documentation.

## Phase 6: Mainnet launch

- **Gated beta** with TVL caps per vault and across the protocol, raised step by
  step as usage and monitoring build confidence.
- **Business model:** a small protocol fee per executed swap, with a subscription
  tier for team and treasury vaults that need advanced policies and alerting.
- **Launch readiness:** legal review of the non-custodial design, terms of
  service, and a public status page.

**Exit criteria:** public mainnet with real USDC and published audit reports.

## Phase 7: Private policies

Public limits are transparent by design, but some owners will not want their
strategy or treasury size visible on-chain.

- **Confidential balances** using Token-2022 confidential transfers.
- **Zero-knowledge policy proofs:** the agent proves that a trade satisfies the
  owner's policy without revealing the limits or the amounts.

This extends Aegis from enforceable limits to enforceable *and private* limits
for enterprise and institutional agents.
