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

The localnet Vite development plugin handles only create, fund, revoke and
withdraw owner actions. It loads `.keys/owner.json` in Node; keys and environment
contents never go to the browser. Signing requires a loopback, same-origin JSON
request with the dashboard header. The browser cannot choose a signer, vault,
policy or withdrawal destination. The plugin is absent in mock mode and the
production preview; localnet signing requires the development server.

```bash
pnpm --filter web test
pnpm --filter web build
```
