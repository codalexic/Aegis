# Terminal demo (C6)

From the repository root, keep `pnpm localnet` running and run:

```bash
pnpm demo
```

The command defaults to localnet. It creates a fresh vault, funds 1,000 testUSDC,
swaps 20, submits the scripted 1,000 injection and destination-redirection attacks,
revokes the agent, tries another swap, then withdraws both token balances to the
owner. Each of the eight steps prints its actual transaction result, signature,
balances, spent and remaining budget, with a one-second pause between steps.

Expected rejections are `CapExceeded`, `AccountMismatch`, and `Revoked`. The demo
requires program-origin failures on localnet and verifies unchanged vault state
after each rejection. It also checks the successful balance transitions, the
attacker's unchanged balance, and the owner's withdrawal receipts. An unexpected
result stops the story and exits with code 1; a full pass exits with code 0.

Localnet uses the ignored `.keys/owner.json` and `.keys/agent.json`. Public
addresses come from `deployments/localnet.json`. Each run gets a fresh nonzero
vault ID, leaving the dashboard's ID 0 and deployment metadata alone. The existing
owner funds the vault; successful runs return 980 testUSDC and 0.2 testSOL, spending
20 testUSDC at the exchange plus local SOL fees and rent. No AI provider is called.

`AEGIS_ENV=mock pnpm demo` runs the same story as a labelled in-memory simulation.
The demo reads `AEGIS_ENV` from the process environment and defaults to localnet;
it does not load the agent's `.env` configuration.

Completion check: start a fresh `pnpm localnet` in another terminal, then run both
demos consecutively against that same chain:

```bash
pnpm exec tsc -p scripts/demo/tsconfig.json
pnpm demo && pnpm demo
```
