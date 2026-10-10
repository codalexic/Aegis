# Aegis

An AI agent trades from a vault while a Solana program enforces a per-trade cap,
total budget, expiry, revocation and a fixed output destination. The owner can
withdraw at any time. This demo runs on a local chain with testUSDC, testSOL and
a tiny fixed-rate exchange: 100 testUSDC buys 1 testSOL.

## Prerequisites

Run everything in **WSL Ubuntu**, with the checkout on the Linux filesystem
(for example, `~/Aegis`). Install Git, Linux build tools (`build-essential`,
`pkg-config`, `libssl-dev`, `libudev-dev`, `clang`, `cmake`) and these versions:

| Tool | Version | Pin |
| --- | --- | --- |
| Anchor CLI | 1.1.2 | [Anchor.toml](Anchor.toml) |
| Solana/Agave CLI, including `solana-test-validator` | 3.1.10 | [Anchor.toml](Anchor.toml) |
| Rust via rustup, with rustfmt | 1.99.0 | [rust-toolchain.toml](rust-toolchain.toml) |
| Node.js | 24.10.0 | [package.json](package.json) |
| pnpm | 12.9.1 | [package.json](package.json) |

Use pnpm for all JavaScript dependencies. Initial installation/build needs internet
access; the scripted demo needs no AI provider or API key.

## Build and run the terminal demo

In a WSL terminal:

```bash
git clone https://github.com/codalexic/Aegis.git
cd Aegis
pnpm install --frozen-lockfile
anchor build --ignore-keys
pnpm idl:sync
pnpm localnet
```

Localnet preloads programs at the committed IDs in the generated IDL.
`--ignore-keys` avoids warnings about newly generated deployment keypairs,
which this preload flow does not use.

Wait for `Localnet ready: http://127.0.0.1:8899` and the deployment-written message.
Keep this terminal running. Localnet preloads both programs, creates test keys and
tokens, seeds the exchange, and writes public addresses to `deployments/localnet.json`.
Run only one localnet at a time; ports 8899, 8900 and 9900 must be free. Ctrl-C stops
it, and running `pnpm localnet` again resets the chain.

In a second WSL terminal, from the same repository directory:

```bash
pnpm demo
```

The story creates a vault, funds 1,000 testUSDC, swaps 20, blocks the scripted
1,000-token injection (`CapExceeded`) and redirect (`AccountMismatch`), revokes
the agent, blocks another swap (`Revoked`), then withdraws both balances. It pauses
one second between steps and ends with:

```text
[localnet] Demo complete: 8/8 steps passed; 3 attacks blocked; vault revoked and empty.
```

Run `pnpm demo` again to repeat with a fresh vault. It defaults to localnet; clear
an exported `AEGIS_ENV=mock` first if you previously used mock mode.

## Dashboard and agent

With localnet still running, start the dashboard from the repository root:

```bash
AEGIS_ENV=localnet pnpm dev
```

Open http://localhost:5173, click **Create vault**, then **Fund 1,000**. This vault
is separate from the terminal demo's vaults. In another terminal:

```bash
AEGIS_ENV=localnet pnpm agent --mode scripted
```

For live AI proposals, create a root `.env` file (git-ignored):

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=your-google-ai-studio-key
```

Then run `AEGIS_ENV=localnet pnpm agent --mode normal` or `--mode injected`.
`--mode attacker` directly tests redirection without an AI call. The dashboard
shows trades and blocked attempts; **Revoke agent** and **Withdraw all** use the
owner key in Node. The browser never receives a key. Test keys stay in ignored
`.keys/`; keep those files and `.env` out of commits.

For an offline simulation, use `AEGIS_ENV=mock pnpm dev` or
`AEGIS_ENV=mock pnpm demo`. Simulated results are labelled `mock`.

Details: [agent providers and modes](scripts/agent/README.md),
[terminal demo](scripts/demo/README.md), [interface specification](docs/planning/INTERFACES.md).

## Devnet

Both programs are deployed; public addresses are committed in
`deployments/devnet.json`. Wallet signing is implemented; see the [dashboard instructions](apps/web/README.md).

Keep the original program keypairs backed up in `.keys/programs/`; the deploy
command verifies their public keys against the committed IDs. A fresh clone
needs those backups to deploy at the same IDs. Deployer, mint, agent and upload
buffer keys stay under ignored `.keys/` with mode 600. Never publish them.

```bash
anchor build
pnpm devnet:deploy --check  # read-only RPC; never sends transactions
```

The check prints the public deployer address, live balance, program sizes and
exact funding shortfall, and exits nonzero if underfunded. Its threshold includes
live account rent, 0.05 SOL for agent fees and a 0.05 SOL transaction-fee allowance.
Actual fees vary; unused SOL stays in the deployer. Fund the printed address with
**devnet SOL** at https://faucet.solana.com (GitHub login provides a higher limit).
The script never requests an airdrop itself.

Once funded and ready to deploy:

```bash
pnpm devnet:deploy
AEGIS_ENV=devnet pnpm demo
# For an existing active, funded devnet vault:
AEGIS_ENV=devnet pnpm agent --mode scripted --vault <VAULT_ADDRESS>
```

Deployment checks funding before any transaction, uses the existing program IDs
and `.keys/devnet-deployer.json` as program upgrade and testSOL mint authority.
It creates testUSDC (6 decimals) with `.keys/devnet-faucet.json` as its dedicated
mint authority and testSOL (9 decimals), seeds 100,000 testSOL in the pool and
10,000 testUSDC for the owner, and funds `.keys/devnet-agent.json`. Reruns reuse mints/pool,
skip identical binaries and top up only missing balances. Upload buffer keys
are preserved for resuming failures. Reruns keep the faucet as testUSDC mint
authority, use it to sign owner testUSDC top-ups, and reject unexpected authorities
without reassigning them. Back up the faucet key locally; a missing key for a
recorded faucet address stops deployment. Run one deployment process at a time.

Successful setup writes public addresses to `deployments/devnet.json`. Pass it
to the SDK with `createClient("devnet", { deployment })`. The agent uses only the
devnet agent key; the demo also uses the deployer. RPC retries use bounded backoff
and identical signed bytes. Signatures link to Explorer with `?cluster=devnet`.
Localnet defaults and loopback restrictions are preserved.

With localnet running, `pnpm test:devnet` checks the funding gate, key reuse and
seeding twice on the local validator. It spends no public devnet SOL.

## Public site on Vercel (D3)

Import the repository root into Vercel with Framework **Other**. `vercel.json`
uses `pnpm build:vercel` to write the [Vercel Build Output API](https://vercel.com/docs/build-output-api)
directory `.vercel/output`: the devnet dashboard in `static/`, routing and discovery
headers from `scripts/vercel/config.json`, and one Node 24 function in
`functions/api/handler.func/`. esbuild bundles `scripts/vercel/handler.ts`, its dependencies,
the public devnet manifest and the generated IDL into `handler.mjs`; no repository
files or installed packages are needed at runtime. Secrets are read only from
runtime environment variables, never substituted into the bundle.
Keep the handler source outside root `api/`: Vercel auto-detects that directory
and would overwrite the bundled function with its unbundled TypeScript output.
The API rewrite passes the public path as `__aegis_path`; the handler
restores `request.url` and removes that internal parameter before routing, preserving
the original Actions query parameters. No dynamic function filenames are needed.
`/api/agent/{info,normal,injected,attacker}`, `/api/faucet`, `/api/deployment` and
`/api/actions/{create,fund,revoke,withdraw,latest-vault}` are available. Owner
signing endpoints are absent; owner transactions require Phantom. The public
site always uses `deployments/devnet.json`, regardless of localnet settings.

Set these exact variables in **Project → Settings → Environment Variables**:

| Variable | Required/value |
| --- | --- |
| `GEMINI_API_KEY` | Secret: existing Google AI Studio Gemini key; needed for Live AI. Scripted works without it. |
| `AEGIS_AGENT_SECRET` | Secret: JSON array of 64 bytes from `.keys/devnet-agent.json`. Must match the manifest's agent. |
| `AEGIS_FAUCET_SECRET` | Secret: JSON array of 64 bytes from `.keys/devnet-faucet.json`. Must match the manifest's `faucet` and current testUSDC mint authority. |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1`, so Vercel uses pinned pnpm `12.9.1`. |
| `AI_MODEL` | Optional Gemini model ID; defaults to `gemini-3.1-flash-lite`. |
| `AEGIS_PUBLIC_ORIGIN` | Optional canonical HTTPS site origin; set for a custom domain. Otherwise uses Vercel's `VERCEL_PROJECT_PRODUCTION_URL` in Production and `VERCEL_URL` in Preview. |

**Never paste `.keys/devnet-deployer.json` anywhere, including Vercel or chat.
It controls program upgrades and must never leave this machine.** The faucet
uses only `.keys/devnet-faucet.json`; fund its public address with devnet SOL for
ATA rent and fees (initial funding: 0.15 SOL).

Vercel supplies `VERCEL`, `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL` and
`VERCEL_URL`; do not copy them from local files. No `VITE_` secret variables.
Server secrets come only from Vercel environment variables; the deployed code
never reads `.keys/` or `.env`. Do not set localnet signing/deployment overrides.
After changing settings, redeploy to apply them.

Agent requests require that the vault authorizes the configured agent. Gemini
quota/HTTP failures produce a clear error and the console offers **Retry scripted**.
Request bodies are limited to 4 KiB. Warm instances enforce six agent calls/IP/
minute, one faucet call/IP/10 minutes, one claim/wallet/10 minutes, and ten faucet
claims/hour. Confirmed chain history also restricts the faucet after cold starts;
recent token-account activity counts toward the wallet cooldown. Concurrent
instances can race on pending claims, so these are demo controls, not atomic global
quotas. Enable the documented Vercel Firewall rule (six API POSTs/IP/minute across
endpoints) before sharing; its counters are per region. No database is required.

Follow [D3 manual steps](docs/planning/D3_MANUAL_STEPS.md) for account/login,
GitHub import, exact private key-copy commands, environment settings, Firewall,
funding, Phantom/private-window testing, curl checks, dial.to and deployed-asset
scanning. Public deployment and wallet acceptance are still manual; local checks
do not establish that the public URL works.

```bash
node apps/web/scripts/check-api-paths.mjs # also runs with web tests
pnpm --filter web test
AEGIS_ENV=devnet pnpm --filter web build
node apps/web/scripts/scan-secrets.mjs
pnpm test:vercel # builds output, copies it outside the repo, invokes it in fresh Node 24
node apps/web/scripts/scan-secrets.mjs .vercel/output/static
node apps/web/scripts/scan-secrets.mjs .vercel/output/functions --server
pnpm test:sdk
pnpm test:agent
```

The Vercel smoke test needs no login, signing keys, model key, or RPC access. It
checks all four Action GETs, agent info, CORS/devnet Action headers, preflight,
query validation, and emitted routing/static files. `--server` permits signer API
and environment variable names in server code; it still scans actual credentials.

## Solana Actions (D4)

With localnet already running, start `AEGIS_ENV=localnet pnpm dev`. The dev server
provides these unsigned [Solana Actions](https://solana.com/docs/tools/actions):

| GET metadata / POST transaction | Parameters in the POST URL or JSON `data` |
| --- | --- |
| `/api/actions/create` | `cap` and `budget` in testUSDC; defaults 50 and 100 |
| `/api/actions/fund` | Required `amount` in testUSDC |
| `/api/actions/revoke` | None |
| `/api/actions/withdraw` | None; both available token balances in one transaction |

Every POST includes `{ "account": "<OWNER_PUBLIC_KEY>" }`. Amounts are decimal
strings, with up to six fractional places. The returned base64 transaction has
the owner as its only signer and fee payer; the client wallet signs and submits
it. Routes never load a key, sign, send, or record an unconfirmed vault. Create
uses the deployment's agent and chain time plus one hour. Revocation and withdrawal
work for the owner's latest confirmed vault, including withdrawal after expiry.

```bash
curl http://127.0.0.1:5173/api/actions/create
curl -X POST 'http://127.0.0.1:5173/api/actions/create?cap=50&budget=100' \
  -H 'Content-Type: application/json' -d '{"account":"<OWNER_PUBLIC_KEY>"}'

pnpm --filter web test
pnpm --filter web test:localnet
pnpm --filter web build
```

Configuration defaults to `deployments/<AEGIS_ENV>.json`. Action routes can use
any cluster's public manifest with the same program IDs and deployment shape:
set `AEGIS_ACTIONS_DEPLOYMENT` to that manifest's path (relative to the repository
or absolute). Its RPC URL, mints, agent and pool are authoritative; callers cannot
override them. `AEGIS_ACTIONS_ORIGIN` optionally sets the canonical HTTP(S) site
origin for the PNG icon; otherwise the local dev-server URL is used. These two
settings configure Actions only; the dashboard continues to use `AEGIS_ENV`.
Chain headers are derived from the configured RPC's genesis hash, so localnet is
labelled with its own chain ID and devnet uses the standard devnet CAIP-2 ID.

`/actions.json` maps site links to the APIs. GET, POST, OPTIONS and action errors
include Actions/CORS headers; key-backed owner, agent and faucet APIs retain
their existing restrictions. `aegis.png` is a 512px render of the existing logo.

Latest-vault lookup scans successful creation transactions in confirmed wallet
history, so it requires an RPC that retains that history. It never ranks random
vault IDs or uses the last unsigned request. In wallet mode
(`AEGIS_ENV=localnet AEGIS_SIGNING=wallet pnpm dev`, or devnet after deployment),
connecting/reloading the dashboard selects that same vault, including one created
through a Blink. Localnet's default server-signing session remains unchanged.

The localnet tests start a real Vite server, call GET and POST for every action,
sign each returned transaction with an ephemeral test keypair, and confirm it on
the validator. They also check CORS, input validation, latest-vault selection,
dashboard discovery, and withdrawal of both token balances after revocation.

**Pending manual acceptance:** host the implemented Vercel routes and test all four
actions with Phantom on dial.to using
`https://dial.to/?action=solana-action:<encoded HTTPS action URL>&cluster=devnet`.
The [D3 manual guide](docs/planning/D3_MANUAL_STEPS.md) covers dial.to and optional
registry submission; no public transactions are needed for automated local checks.
