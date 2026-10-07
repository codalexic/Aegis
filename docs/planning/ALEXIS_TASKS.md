# Alexis: SDK, Dashboard and AI Agent (24 hours)

Alexis builds everything the audience sees and owns `packages/sdk/`, `apps/web/`, `scripts/agent/`, `scripts/demo/` and `tests/e2e/`. Follow [INTERFACES.md](INTERFACES.md).

Alexis never waits for Mariam: until H2 (Day 2 hour 6) everything runs against the mock client. If the IDL is unclear, write the question down and keep going on the mock.

## Day 1

**Hour 1 — M-1 with Mariam.** Approve the interface.

**Hours 2–3 — SDK and mock.** TypeScript types, the `AegisClient` interface and `MockAegisClient`, which returns the outcomes in INTERFACES §8 (for example, a 60 swap returns `CapExceeded`). Label it as mock everywhere it appears.

**Hours 4–8 — Dashboard** (one page, against the mock):

- vault card: owner, agent, cap, budget, expiry, revoked status, balances;
- **remaining-budget bar** that drops on each trade;
- buttons: Create vault, Fund, Revoke agent, Withdraw;
- activity list with success/blocked badges and the program's error name;
- environment label (`mock` / `localnet`) always visible.

No browser wallet and no key in the browser: on localnet, owner actions go through a Vite dev-server endpoint that signs with the test owner key in Node (INTERFACES §7). Keep it clean, not fancy.

## Day 2

**Hours 1–4 — AI agent** (`scripts/agent/`). A Node script that holds only the agent key. It asks an AI model what to trade; the model returns only an amount; the script calls `swap`. The model never sees a key. Modes:

- **normal:** reasonable market text → the model picks 20 → succeeds;
- **injected:** the "news" text contains a hidden instruction to swap everything → the model asks for a large amount → program returns `CapExceeded`;
- **attacker:** uses `swapRaw` to send output to an attacker account, skipping client checks → program returns `AccountMismatch`;
- **scripted:** the same three without the AI model, for when the AI or internet fails.

Print each step clearly; this output appears in the demo.

**Hours 5–6 — Real client.** `AnchorAegisClient` built from Mariam's IDL (H1): all methods, `swapRaw`, error mapping by name, `listActivity` via `getSignaturesForAddress`.

**Hour 7 — Switch to the real chain.** Run Mariam's `pnpm localnet` (`scripts/localnet/start.ts`) (H2), point the dashboard and agent at it, and write down anything that does not match.

**Hour 8 — M-2 with Mariam.** First real swap through the SDK.

## Day 3

**Hours 1–4 — Terminal demo and end-to-end checks.** `scripts/demo/run`: runs the full demo story (create, fund, normal swap, injected attack, redirect attack, revoke, blocked swap, withdraw) on the real chain and prints signatures and balances. This is the backup if the dashboard fails. Then run the cases from INTERFACES §8 through the SDK in `tests/e2e/`.

**Hours 5–8 — M-3 with Mariam.** Freeze at hour 5. Rehearse the three-minute demo, record the backup video, write a short README with start commands.
