# Aegis Phase 2: Public Devnet Demo (free)

Goal: anyone can open a public link, connect Phantom on Solana devnet, create and fund a vault, watch the AI agent get tricked and the program block it, and do the same from a Blink. Everything uses free services: Solana devnet, the devnet faucet, Phantom, Vercel's free plan, dial.to and the Gemini free tier.

Rules for every task: follow [AGENTS.md](../../AGENTS.md); one task at a time; `git pull` first; commit and push only when the "Done when" check passes. **The localnet demo must keep working**: `pnpm start:demo`, `pnpm demo` and all existing tests stay green after every task. Steps marked 👤 need the person (logins, faucet, approvals); stop and ask for them instead of working around them.

Before D1: `git tag pre-devnet && git push origin pre-devnet`.

| Order | Task | Contract change? |
| --- | --- | --- |
| 1 | D1 Devnet deployment | No |
| 2 | D2 Phantom owner signing and test-token faucet | No |
| 3 | D3 Public site on Vercel | No |
| 4 | D4 Blinks (Solana Actions) | No |
| 5 | D5 Pyth price guard (optional, last) | **Yes** |

---

## D1 Devnet deployment

**Files:** `scripts/devnet/`, `deployments/devnet.json`, `packages/sdk/`, `scripts/demo/`, `scripts/agent/`, `package.json`, `README.md`.

- **Back up program keypairs first.** Copy `target/deploy/aegis-keypair.json` and `target/deploy/demo_dex-keypair.json` to `.keys/programs/` (git-ignored). Losing them means the programs can never be upgraded.
- Create `.keys/devnet-deployer.json` if missing and print only its public key.
- 👤 Alex funds the deployer with devnet SOL at https://faucet.solana.com (sign in with GitHub for a higher limit). Print how much SOL the deploy needs (from the `.so` sizes) and stop until the balance is enough.
- `pnpm devnet:deploy`: deploys both programs to devnet with the existing program IDs (upgrade authority = deployer); creates testUSDC (6 decimals) and testSOL (9 decimals) with the deployer as mint authority; calls `initialize_pool`; funds the pool with 100,000 testSOL; creates and funds a devnet agent key in `.keys/devnet-agent.json` with a little SOL for fees; writes `deployments/devnet.json` (public addresses only, same shape as `localnet.json`, `environment: "devnet"`, `rpcUrl: "https://api.devnet.solana.com"`). Re-running it must be safe: reuse existing mints and pool if they already exist.
- Add `"devnet"` as an environment in the SDK, agent and demo script. RPC errors and rate limits on the public endpoint retry with backoff.
- Explorer links use `?cluster=devnet` when the environment is devnet.
- README: a short "Devnet" section.

**Done when:** `pnpm devnet:deploy` succeeds; `AEGIS_ENV=devnet pnpm demo` completes 8/8 on devnet and its signatures open on https://explorer.solana.com with `?cluster=devnet`; all localnet tests and `pnpm demo` on localnet still pass.

## D2 Phantom owner signing and test-token faucet

**Files:** `packages/sdk/`, `apps/web/`.

- In devnet mode the **owner signs in the browser with Phantom** using `@solana/wallet-adapter-react` (Phantom only is fine). The SDK must accept a wallet-adapter signer (build unsigned transactions, let the wallet sign, then send and confirm). Localnet mode keeps the current dev-server signing unchanged.
- The vault's agent is the public key from `deployments/devnet.json`; the agent key stays server-side.
- **Faucet:** button **Get 1,000 testUSDC** calls a server endpoint that mints testUSDC to the connected wallet's token account (creating it if needed) using the mint authority key server-side. Limit: once per wallet per 10 minutes and a small global cap per hour; return a clear message when limited.
- Dashboard in devnet mode: Connect wallet button, owner = connected wallet, New demo vault creates and funds from the connected wallet (one Phantom approval per transaction is fine), Revoke and Withdraw all go through Phantom. The agent console works exactly as on localnet.
- Badge shows `DEVNET`. No key ever reaches the browser.

**Done when:** 👤 with Phantom set to devnet, Alex can connect, get testUSDC, create and fund a vault, run all three agent buttons with the expected results, revoke and withdraw; web tests cover the faucet limiter and the devnet signer path; `pnpm --filter web build` passes and `grep -rE "AIza|secretKey" apps/web/dist` finds nothing; localnet mode unchanged.

## D3 Public site on Vercel

**Files:** `apps/web/`, `api/` (Vercel functions) or `apps/web/api/`, `vercel.json`, `README.md`.

- Move the devnet server endpoints (agent actions, faucet) into Vercel serverless functions. Secrets come from Vercel environment variables only: `GEMINI_API_KEY`, `AEGIS_AGENT_SECRET` (devnet agent key), `AEGIS_FAUCET_SECRET` (devnet mint authority). Never commit them; document them in the README.
- The public site is **devnet only**; localnet signing endpoints are not deployed.
- Abuse limits: per-IP limit on agent and faucet endpoints; if Gemini returns a quota or 5xx error, the response says so and the console offers Scripted. Agent endpoints only act on vaults whose agent is the server's agent.
- 👤 Alex creates a free Vercel account, runs `vercel login`, links the GitHub repo and sets the three environment variables (Codex prints exact instructions and stops for this).
- Add a short "How to try it" box on the page: install Phantom → switch to devnet → Get testUSDC → New demo vault.

**Done when:** the public URL works end to end in a private browser window with Phantom on devnet; `curl` on the agent endpoint from outside returns the expected JSON; no secret appears in the deployed bundle.

## D4 Blinks (Solana Actions)

**Files:** `apps/web/api/actions/` (or the Vercel functions folder), `apps/web/public/actions.json`, `README.md`.

- Implement Solana Actions with `@solana/actions`: `actions.json` at the site root, correct CORS and action headers on every action route, devnet chain ID.
- Actions:
  - **Create Aegis vault**: parameters for per-trade cap and total budget (defaults 50 and 100), creates a vault for the signing wallet with the server agent and 1-hour expiry.
  - **Fund vault**: amount parameter, transfers testUSDC from the wallet to its latest vault.
  - **Revoke agent** and **Withdraw all** for the wallet's latest vault.
- Each GET returns title, description, an icon (the Aegis logo as PNG) and the action buttons; each POST builds an unsigned transaction for the provided `account`.
- Validate inputs with the same rules as the program; return action errors as JSON messages.
- 👤 Test on dial.to: `https://dial.to/?action=solana-action:<encoded action URL>&cluster=devnet`. 👤 Optional: submit the actions to the Dialect registry so they unfurl on X; approval takes time and does not block anything.

**Done when:** dial.to renders all four actions; signing with Phantom on devnet confirms each transaction; the vault created by the Blink appears on the public dashboard.

## D5 Pyth price guard (optional, contract change)

Only start after D1–D4 are done and the demo is stable. This replaces the fixed demo rate with a real devnet price feed so "slippage protection" becomes accurate.

**Files:** `programs/demo_dex/`, `programs/aegis/`, `tests/program/`, `docs/planning/INTERFACES.md`, deploy scripts.

- Tag first: `git tag pre-pyth && git push origin pre-pyth`.
- Use the Pyth SOL/USD feed on devnet through the Pyth pull oracle (`pyth-solana-receiver-sdk`). The DEX quotes testSOL per testUSDC from the feed; Aegis takes `max_slippage_bps` in the vault policy and checks the actual output against the oracle price, rejecting stale prices (older than 60 s) and wide confidence intervals with new errors `StalePrice` and `SlippageExceeded`.
- Every existing check stays. Update all tests; add tests for stale price, low confidence and slippage beyond the limit.
- Redeploy to devnet with `pnpm devnet:deploy` (program upgrade) and update the SDK and agent to post a fresh price update in the same transaction.

**Done when:** all program, SDK, e2e and devnet demo checks pass; Claude reviews the contract diff line by line before it is deployed.

**Not free, not in this phase:** mainnet deployment, real Jupiter swaps, an audit. ZK hidden limits are free but a multi-day research task; plan them separately after D1–D4.
