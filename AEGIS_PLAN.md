# Aegis Three Day Plan

Updated: 7 October 2026

Team: **Mariam** builds the on-chain programs. **Alexis** builds the SDK, dashboard and AI agent.

Budget: three days, about eight focused hours per person per day (24 hours each).

## 1 What we show

**An AI agent trades from a vault. When the agent is tricked into stealing or overspending, the Solana program blocks it, and the owner can always take the money back.**

Three-minute demo:

| Time | Show |
| --- | --- |
| 0:00–0:30 | The problem: AI agents holding keys can be tricked. Owner, agent, cap (50) and budget (100) on screen |
| 0:30–1:00 | Owner creates a vault and funds it with 1,000 testUSDC |
| 1:00–1:30 | Agent makes a normal 20 testUSDC swap; it succeeds and the budget bar drops |
| 1:30–2:15 | Agent reads a planted "news" message telling it to swap everything to an attacker; the agent obeys; the program rejects both the oversized trade and the redirect |
| 2:15–2:40 | Owner revokes the agent; the agent's next trade fails |
| 2:40–3:00 | Owner withdraws everything. Roadmap in one sentence: hidden limits (ZK) and real DEX routing (Jupiter) |

Everything runs on a local Solana chain with test tokens. We say so on screen.

## 2 Scope

| Building | Not building |
| --- | --- |
| One vault per owner, one agent, fixed policy set at creation | Policy updates, multiple agents, sessions |
| Per-trade cap, total budget, expiry, revoke | Nonces, deadlines, slippage settings |
| Fixed output destination (the vault itself) | Arbitrary recipients or instructions |
| Tiny test exchange: one pool, fixed rate, real token transfers | Jupiter, real DEXs, price oracles |
| Owner withdraw at any time, even after revoke or expiry | ZK proofs, hidden policies |
| SDK, one-page dashboard, AI agent with a scripted fallback | Backend server, database, indexer, devnet/mainnet |

Funding is a plain token transfer into the vault's token account, so no deposit instruction is needed.

## 3 Fixed values

| Setting | Value |
| --- | --- |
| Input token | testUSDC, 6 decimals |
| Output token | testSOL, 9 decimals |
| Exchange rate | 100 testUSDC = 1 testSOL, so output raw = input raw × 10 |
| Vault funding | 1,000 testUSDC |
| Per-trade cap | 50 testUSDC (50000000 raw) |
| Total budget | 100 testUSDC (100000000 raw) |
| Expiry | One hour after creation |
| Normal swap | 20 testUSDC (20000000 raw) → 0.2 testSOL (200000000 raw) |

## 4 How the team works

Mariam and Alexis work separately and meet **three times**:

| Meeting | When | Purpose |
| --- | --- | --- |
| M-1 | Day 1, first hour | Read [INTERFACES.md](docs/planning/INTERFACES.md) together and approve it |
| M-2 | Day 2, last hour | First real swap from Alexis's SDK against Mariam's program |
| M-3 | Day 3, hours 5–8 | Fix, freeze, rehearse, record |

Between meetings, Mariam passes work to Alexis as files in the repository:

| Handoff | When | What |
| --- | --- | --- |
| H1 | Day 1, hour 3 | Generated IDL (the program's interface file) with all final instructions and errors |
| H2 | Day 2, hour 6 | `pnpm localnet` (`scripts/localnet/start.ts`): one command that starts a local chain with programs, tokens, pool and test wallets |

Until H2 arrives, Alexis works against a mock. Questions go in writing; nobody stops work waiting for an answer. Each person posts a three-line status at the end of each day.

**Before Day 1 (required):** both have Node, and Mariam has Rust, Solana CLI and Anchor working in WSL. Run `anchor init` and `anchor test` on a sample project. If this fails on Day 1, the plan fails.

## 5 Schedule

| | Mariam | Alexis |
| --- | --- | --- |
| **Day 1** | M-1. Program skeleton and IDL (H1). Create vault, revoke, withdraw, with tests | M-1. SDK types and mock. Dashboard against the mock |
| **Day 2** | Test exchange and swap with all checks. Local chain script (H2). M-2 | AI agent with attack scenarios. Real SDK from the IDL. Switch to the real chain. M-2 |
| **Day 3** | Attack tests. Fixes. M-3 | Terminal demo script and end-to-end checks. M-3 |

**Feature freeze: Day 3, hour 5.** After that, only fixes, rehearsal and the backup recording.

Detailed tasks: [Mariam](docs/planning/MARIAM_TASKS.md) · [Alexis](docs/planning/ALEXIS_TASKS.md) · [Coding-agent tasks](docs/planning/CODEX_TASKS.md) (with [AGENTS.md](AGENTS.md))

## 6 Plan B decisions

Each decision has a fixed time. Make it at that time; do not keep trying.

| When | If | Then |
| --- | --- | --- |
| Day 1, hour 6 | Create vault or withdraw still fails | Mariam stops polishing and asks for help immediately; Alexis continues on the mock |
| Day 2, hour 4 | The swap through the test exchange does not work | Replace the swap with a **payment**: the agent may pay a fixed merchant account, with the same cap, budget, expiry and revoke. Demo story stays the same. About one hour of work |
| Day 2, M-2 | SDK cannot run a real swap | Day 3 morning becomes joint integration; Alexis drops dashboard polish |
| Day 3, hour 5 | Dashboard is not reliable | Present with the terminal demo script |
| On stage | AI or internet fails | Agent runs in scripted mode with the same attacks |

Never remove a security check to save time. A smaller demo that is true beats a larger one that is not.

## 7 Done checklist

- [ ] One command starts the local chain from a clean clone.
- [ ] Create, fund, swap, revoke and withdraw work through the SDK.
- [ ] Attack tests pass: over cap, over budget, redirect, wrong signer, revoked, expired, agent tries to withdraw.
- [ ] Dashboard shows real chain state.
- [ ] AI agent attack works live and in scripted mode.
- [ ] Terminal demo script runs the full story without the dashboard.
- [ ] No private key in the repository or sent to the AI.
- [ ] Backup recording of the full demo.
