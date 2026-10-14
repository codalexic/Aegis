# Deployment: devnet and Vercel

How the programs were deployed to Solana devnet and how the public site at
[aegis.axssell.com](https://aegis.axssell.com) is built and hosted.

## Devnet

Both programs are deployed; public addresses are committed in
`deployments/devnet.json`. Wallet signing is implemented; see the [dashboard instructions](../apps/web/README.md).

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

## Public site on Vercel

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
| `VITE_DEVNET_RPC_URL` | Optional public browser HTTPS devnet RPC URL, set at build time; defaults to `https://api.devnet.solana.com`. |

**Never paste `.keys/devnet-deployer.json` anywhere, including Vercel or chat.
It controls program upgrades and must never leave this machine.** The faucet
uses only `.keys/devnet-faucet.json`; fund its public address with devnet SOL for
ATA rent and fees (initial funding: 0.15 SOL).

Vercel supplies `VERCEL`, `VERCEL_ENV`, `VERCEL_PROJECT_PRODUCTION_URL` and
`VERCEL_URL`; do not copy them from local files. No `VITE_` secret variables.
Server secrets come only from Vercel environment variables; the deployed code
never reads `.keys/` or `.env`. Do not set localnet signing/deployment overrides.
After changing settings, redeploy to apply them.

Agent requests require that the vault authorizes the configured agent. Transient
Gemini failures are retried with backoff; if Live AI is still unavailable, the
scenario runs with its recorded reply and the console says so.
Request bodies are limited to 4 KiB. Warm instances enforce six agent calls/IP/
minute, ten faucet calls/IP/10 minutes, one claim/wallet/10 minutes, and thirty faucet
claims/hour. Confirmed chain history also restricts the faucet after cold starts;
only successful testUSDC mints signed by the faucet authority count, and only mints
to the wallet’s token account start its cooldown. Owner transfers do not. Limit
messages give the remaining wait, rounded up to minutes. Concurrent
instances can race on pending claims, so these are demo controls, not atomic global
quotas. Enable the documented Vercel Firewall rule (20 API POSTs/IP/minute across
endpoints) before sharing; its counters are per region. No database is required.

### Deployment

Set `VITE_DEVNET_RPC_URL` to a browser-accessible devnet provider endpoint before
building, then redeploy. For local builds it can also be set in the root `.env`.
This URL is visible in the JavaScript bundle and network requests: use only a
public endpoint or a provider credential explicitly intended for public browser
use, restricted to the site's origin. Never put a private API key, signing key,
or server secret in a `VITE_` variable. Server RPC and localnet settings are unchanged.
Custom endpoints are checked against the devnet genesis hash before use.

The devnet dashboard polls vault state every 10 seconds (two RPC requests) and
activity every 20 seconds (one signature request), without overlapping polls.
After the initial load, an idle visible dashboard with a vault makes **15 RPC
requests per minute**, excluding retries and user actions; a hidden tab starts
no polls. Without a vault it makes no periodic RPC requests. Activity starts with
the latest 20 signatures and then loads only newer entries, caching transaction
details. Confirmed owner actions refresh state and activity immediately; RPC
backoff or an in-flight poll can delay that refresh.

1. Sign in to Vercel and import this GitHub repository. Use the repository root,
   Framework **Other**, Node **24.x**, and enable Fluid Compute. Keep the build
   settings from `vercel.json` and the pinned pnpm version.
2. Set the environment variables listed above for the target environment. Supply
   `AEGIS_AGENT_SECRET` and `AEGIS_FAUCET_SECRET` privately from their dedicated
   key files; `GEMINI_API_KEY` enables Live AI. Set `ENABLE_EXPERIMENTAL_COREPACK=1`.
3. Deploy. For a custom domain, set `AEGIS_PUBLIC_ORIGIN` to its exact HTTPS origin.
   Redeploy after changing environment variables. Allow public access to the
   Production URL so the dashboard and Actions work without a Vercel login.
4. In Vercel Firewall, add a rate-limit rule matching both paths starting with
   `/api/` and method `POST`: a fixed 60-second window, 20 requests, counted by
   IP, with a 429 response. Publish the rule before sharing the site.
5. Fund the agent, faucet and Phantom wallet public addresses with devnet SOL for
   fees and account rent. Connect Phantom on devnet, get testUSDC, create and fund
   a vault, exercise the trading scenarios, then revoke and withdraw.
6. Verify `/api/agent/info`, `/api/deployment` and `/api/actions/create` return JSON,
   and `/api/owner/create` returns 404. Test the Actions through dial.to as described
   below. Run the checks below and scan the deployed JavaScript assets with
   `node apps/web/scripts/scan-secrets.mjs <downloaded-assets-directory>`.

Local checks do not establish that the public URL or Phantom signing works.

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
