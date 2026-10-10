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

With an AI provider configured in the ignored root `.env`, try the trading scenarios:

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

## Wallet owner signing

The usual `pnpm start:demo` / `AEGIS_ENV=localnet pnpm dev` flow still uses the
local owner API. To exercise browser wallet signing against the same local chain:

```sh
pnpm localnet # if it is not already running
AEGIS_ENV=localnet AEGIS_SIGNING=wallet pnpm dev
```

After deploying the programs to devnet, `AEGIS_ENV=devnet pnpm dev` selects wallet
signing automatically and reads `deployments/devnet.json`.
Connect Phantom on the selected cluster; the connected wallet needs SOL there for
fees and account rent. Get 1,000 testUSDC, then New demo vault requests two wallet
approvals (create and fund). Revoke and each nonempty withdrawal request another
approval. If funding is declined, the created vault stays selected for Fund 1,000.
Disconnecting or changing wallets clears the selected vault.

`@aegis/sdk/wallet` exports `WalletAegisClient` and `WalletSigner`. Pass the adapter's
public key and `signTransaction`. It builds v0 owner transactions locally, simulates,
asks the wallet to sign, verifies the unchanged message and owner signature, sends,
and confirms. A small public-only transaction envelope supplies Phantom's web3
serialization shape; it cannot sign with local keys. The React integration uses the
pinned wallet-adapter-react base provider and hooks without mobile auto-discovery.

The faucet creates the wallet's input-token ATA and mints exactly 1,000 testUSDC in
one server-signed transaction. In devnet, the local server loads only
`.keys/devnet-faucet.json`, verifies the manifest’s `faucet` address and current
testUSDC mint authority, and never uses the deployer for claims. Limits are one
claim per wallet per ten minutes and ten claims total per rolling hour. Allowances are reserved before RPC awaits and
retained on uncertain failures. Limits live in the server process and reset when it
restarts. These development endpoints are restricted to the loopback dashboard.
For public hosting and distributed abuse controls, see
[Deployment](../../README.md#deployment). Agent requests in wallet mode identify
the selected vault, and the server verifies that it authorizes the server's agent.

Checks:

```sh
pnpm --filter web test
pnpm --filter web test:localnet # requires pnpm localnet; uses an in-memory mock wallet signer
pnpm --filter web build
grep -rE "AIza|secretKey" apps/web/dist # expected: no matches (exit 1)
```

The localnet integration uses the actual faucet endpoint/mint, browser client, and
all three agent endpoints with Scripted replies. It asserts successful normal trading,
on-chain `CapExceeded` and `AccountMismatch` rejections with unchanged vault balances,
revocation and both withdrawals. Private test signing material stays in Node.

To verify Phantom signing on devnet, deploy the programs and fund the wallet with
devnet SOL, then try the same trading scenarios in the extension. Automated
localnet signing does not verify the Phantom extension integration.
