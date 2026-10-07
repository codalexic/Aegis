# Aegis Three Day Plan

Updated: 7 October 2026

Team: **Alexis** and **Mariam**.

Approach: a coding agent (Codex) builds the whole project first, run by Alexis, task by task from [CODEX_TASKS.md](docs/planning/CODEX_TASKS.md). Then Alexis and Mariam review and improve it together and split the follow-up work.

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

## 4 How we work

**Phase 1 — Build (Alexis + Codex).** Alexis runs Codex through every task in [CODEX_TASKS.md](docs/planning/CODEX_TASKS.md), one at a time, in order: programs first (P0–P6), then client (C0–C7). Each task ends with its check passing, a commit and a push. Rules for the agent are in [AGENTS.md](AGENTS.md).

**Meanwhile (Mariam).** Prepares the pitch: slides, the three-minute script, answers to likely judge questions. Can read pushed code at any time but does not change it during Phase 1.

**Phase 2 — Review (both).** When Codex has finished, Alexis and Mariam go through the review checklist at the end of CODEX_TASKS.md, starting with the security checks in `programs/aegis`. Fixes and improvements are then split between them.

**Phase 3 — Rehearse.** Clean restart, rehearse the demo three times, record a backup video.

**Before starting:** Rust, Solana CLI, Anchor, Node and pnpm installed in WSL (Ubuntu). Everything runs in WSL.

## 5 Schedule

| | Alexis + Codex | Mariam |
| --- | --- | --- |
| **Day 1** | P0–P4: workspace, both programs, vault lifecycle, swap with all checks | Pitch and slides |
| **Day 2** | P5–P6: local chain, attack tests. C0–C4: SDK, dashboard, AI agent, real chain | Pitch; reads pushed code |
| **Day 3 morning** | C5–C7: end-to-end tests, terminal demo, README | Joins review as soon as C-tasks finish |
| **Day 3 afternoon** | Review together, fix, freeze, rehearse, record | Same |

**Feature freeze: Day 3, 15:00.** After that, only fixes, rehearsal and the backup recording.

[MARIAM_TASKS.md](docs/planning/MARIAM_TASKS.md) and [ALEXIS_TASKS.md](docs/planning/ALEXIS_TASKS.md) describe the earlier two-person split; they are kept as reference for dividing work after the build.

## 6 Plan B decisions

Each decision has a fixed time. Make it at that time; do not keep trying.

| When | If | Then |
| --- | --- | --- |
| Any task | Codex fails the same check three times | Stop, copy the error, ask for help (Mariam or Claude) before continuing |
| End of Day 1 | P4 (swap through the test exchange) does not work | Replace the swap with a **payment** to a fixed merchant account, same cap, budget, expiry and revoke (see P4). Demo story stays the same |
| End of Day 2 | Dashboard cannot use the real chain | Present with the terminal demo script (C6); spend Day 3 morning on C6 first |
| Day 3, 15:00 | Dashboard is not reliable | Present with the terminal demo script |
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
