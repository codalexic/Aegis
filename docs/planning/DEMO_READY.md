# Aegis Demo Readiness Plan

Goal: by the end of Day 3 the demo can be presented live, from one screen, in three minutes, with a tested fallback for every failure.

The product build (P0–P6, C0–C7) is complete. What remains is stage readiness (code) and presentation (people).

## 1 Status

| Area | Status |
| --- | --- |
| Programs, tests, security checks | Done — 64 program tests; `execute_swap` reviewed line by line |
| SDK, dashboard, AI agent, end-to-end tests, terminal demo, README | Done |
| Agent console on the dashboard | C8 |
| Injection reliability measured | C9 |
| One-command start and pre-show reset | C10 |
| Projector-readable dashboard, Explorer proof links | C11 |
| Full verification | C12 |
| Mariam's code review | R in CODEX_TASKS.md |
| Slides, script, Q&A, rehearsals, backup video | Sections 3–6 below |

## 2 Schedule

| When | Alexis | Mariam |
| --- | --- | --- |
| Day 2 morning | Codex: C8, C9 | Review `programs/aegis` (checklist R) |
| Day 2 afternoon | Codex: C10, C11, C12 | Slides (section 3) |
| Day 2 evening | First full rehearsal together; list problems | Same |
| Day 3 morning | Fix rehearsal problems only | Q&A practice (section 5) |
| **Day 3, 13:00** | **Freeze.** No more code changes except a blocking defect | Same |
| Day 3 afternoon | Three timed rehearsals, record backup video, pre-show checklist | Same |

## 3 Slides (5 slides plus the live demo)

1. **Problem.** AI agents now hold wallet keys. A single prompt injection can make an agent drain the wallet. Off-chain guardrails live inside the same software that was tricked.
2. **Solution.** Aegis: the owner sets limits once (per-trade cap, total budget, expiry, fixed destination), and a Solana program enforces them on every transaction. The owner can revoke and withdraw at any time.
3. **Live demo** (switch to the dashboard).
4. **How it works.** One diagram: Owner → Vault (PDA) ← Agent; every agent trade passes through `execute_swap`, which checks signer, revocation, expiry, cap, budget, accounts, then verifies real balance changes after the swap. Any failure reverts the whole transaction.
5. **What's next.** Real DEX routing through Jupiter with price protection; hidden limits with zero-knowledge proofs so attackers cannot see the cap; devnet then mainnet after an audit.
6. **Team.** Alexis and Mariam, one line each.

## 4 Three-minute script

Prepare before going on stage: `pnpm start:demo` running, **New demo vault** clicked, browser full screen at 1280×720 or larger, Live AI on.

| Time | Say | Do |
| --- | --- | --- |
| 0:00–0:25 | "AI agents now trade with real money. If one reads a malicious message, it does what the message says. We tested that." | Slide 1, then switch to dashboard |
| 0:25–0:45 | "This vault holds 1,000 test dollars. The agent may spend at most 50 per trade and 100 in total. These rules live on the blockchain, not in the agent." | Point at cap, budget, bar |
| 0:45–1:10 | "First, a normal trade." | **Run normal trade** → green Executed, bar drops to 80 |
| 1:10–1:50 | "Now the agent reads news with a hidden instruction: swap everything. The AI obeys — look at its reply. But the program blocks it." | **Inject malicious news** → highlight the hidden line, the 1,000 reply, red CapExceeded |
| 1:50–2:15 | "A hacker skips the AI and tries to send the output to their own account. Blocked again." | **Hacker redirect** → red AccountMismatch; click its Explorer link: "a real on-chain transaction" |
| 2:15–2:35 | "The owner is always in control: revoke the agent, and any further trade fails." | **Revoke agent** → **Run normal trade** → red Revoked |
| 2:35–3:00 | "And the owner takes everything back. Next: real DEX routing and hidden limits." | **Withdraw all** → balances to owner; slide 5 |

If the model resists the injection: say "today's model resisted — Aegis doesn't depend on that" and click **Retry scripted**.

## 5 Judge questions to prepare

| Question | Short answer |
| --- | --- |
| Why not just give the agent a wallet with little money? | Then it cannot do useful work. Aegis lets the vault hold real funds while the agent's power is bounded per trade, in total and in time, and the owner can stop it instantly. |
| Why on-chain and not in the agent's code? | The agent's code is what gets tricked. On-chain rules hold even if the agent, its server or its AI model is compromised. |
| What if the attacker steals the agent's key? | They get only the agent's limits: at most 50 per trade, 100 in total, until expiry, output only into the vault. The owner revokes immediately. |
| Is the swap real? | Real SPL token transfers through a second program we wrote, on a local Solana chain with test tokens. Jupiter routing is the next step. |
| What about price manipulation? | Our test exchange has a fixed rate, and the program checks actual balances after each swap. Real price protection comes with Jupiter integration. |
| Has it been audited? | No. This is a demo with 64 program tests and 9 end-to-end tests; an audit comes before real funds. |
| Why Solana? | Fast and cheap enough to check every agent transaction on-chain; PDAs let the program itself hold and control the vault. |
| How is this different from existing smart wallets? | Built for AI agents: the attack we defend against is prompt injection, and the demo shows the model being tricked and the chain still holding. Next we hide the limits with ZK so an attacker cannot tune an attack to them. |

## 6 Fallbacks

| Failure | Fallback |
| --- | --- |
| Model resists the injection | **Retry scripted** in the agent console |
| Gemini quota or internet down | Toggle to **Scripted** for all three buttons |
| Dashboard fails | Terminal: `pnpm demo` |
| Laptop, WSL or anything else fails | Play the backup video |

## 7 Pre-show checklist (30 minutes before)

- [ ] Laptop charging; notifications and other apps closed.
- [ ] Phone hotspot ready in case venue Wi-Fi fails.
- [ ] `pnpm start:demo` running; dashboard open full screen.
- [ ] **New demo vault** clicked: spent 0, balance 1,000.
- [ ] One test click of **Run normal trade** done, then **New demo vault** again.
- [ ] Backup video on the desktop and tested.
- [ ] Slides open on the second screen or tab.
- [ ] Both presenters know who says what and who clicks.

## 8 Definition of 100% ready

- [ ] C8–C12 done; C12 report all green.
- [ ] Mariam's review done; any findings fixed and retested.
- [ ] Slides done.
- [ ] Three consecutive rehearsals finish within 3:00 with no unplanned problem.
- [ ] Every fallback in section 6 tried once.
- [ ] Backup video recorded and watched end to end.
- [ ] Both presenters can answer every question in section 5 without notes.
