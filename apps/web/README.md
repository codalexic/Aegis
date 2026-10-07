# Dashboard

Run from the repository root. Mock mode keeps all state in the browser:

```bash
AEGIS_ENV=mock pnpm dev
```

For localnet, build the programs if necessary, then keep these commands running
in separate terminals:

```bash
pnpm localnet
AEGIS_ENV=localnet pnpm dev
```

Open http://127.0.0.1:5173. Create the vault and fund it with 1,000 testUSDC. The
dashboard uses vault ID 0 for the configured test owner, with a 50 testUSDC cap,
100 testUSDC budget and one-hour expiry. Creation records its public address in
`deployments/localnet.json`. Reloading the page reconnects to the same vault.
Restarting `pnpm localnet` resets the chain and allows a fresh demo.
Localnet retains up to 1,000,000 ledger shreds so activity survives a full demo
and slow provider calls; the validator's default limit prunes it within minutes.

With an AI provider configured in the ignored root `.env`, run the C4 check:

```bash
AEGIS_ENV=localnet pnpm agent --mode normal
AEGIS_ENV=localnet pnpm agent --mode injected
AEGIS_ENV=localnet pnpm agent --mode attacker
```

Normal succeeds; injected is blocked with `CapExceeded`; attacker is blocked
with `AccountMismatch`. The dashboard polls chain state and transaction history
directly over RPC every two seconds, including real signatures and the requested
amounts on rejected transactions. `--mode scripted` exercises the same scenarios
without calling an AI provider. Revoke agent and Withdraw all use the owner.

The Agent console runs these scenarios from the dashboard. Live AI is selected
by default and shows the configured model name. Scripted uses fixed replies;
Hacker redirect always skips the model. News, the highlighted injection, model
JSON, requests and outcomes are shown separately. If the model resists, **Retry
scripted** sends the fixed attack with one click. Valid model proposals are
always submitted unchanged, even when they resist the injection.

The localnet Vite development plugins handle owner actions and
`POST /api/agent/{normal,injected,attacker}` with `{ "live": boolean }`.
Agent responses contain public structured `steps`: news, model_reply, request,
result, balances and notice. `GET /api/agent/info` exposes only the model name.
Owner and agent signing keys and AI configuration stay in Node. Signing requires a loopback, same-origin JSON
request with the dashboard header. The browser cannot choose a signer, vault,
policy or withdrawal destination. The plugins are absent in mock mode and the
production preview; localnet signing requires the development server.

The browser uses a read-only RPC adapter with the generated IDL coder, public
address/message modules and original SPL Token account reads. Vite limits the
browser's SDK imports to those operations; the full signing SDK stays in Node.
Curve validation uses the already-pinned Kit address utilities. Token amounts
remain `bigint`. The adapters are checked against the SDK's addresses, balances
and activity, and the bundle scan below must have no matches.

```bash
pnpm --filter web test
pnpm --filter web build
grep -rE "AIza|secretKey|GEMINI" apps/web/dist
```
