# D3: publish the devnet demo yourself

Code and automated checks are separate from public acceptance. No Vercel login,
link, deployment, account creation or Phantom approval was performed by the coding
agent. Follow these steps yourself. Run terminal commands in **Ubuntu / WSL**, from
`/home/thegoattsiklauri/Aegis`. Both Solana programs are already deployed; do not
redeploy them for this task.

## 1. Create the Vercel project and connect GitHub

1. Open https://vercel.com/signup, choose a personal **Hobby** account, and continue
   with GitHub. If you already have an account, sign in instead.
2. Open https://vercel.com/new. Under **Import Git Repository**, select
   **codalexic/Aegis**. If it is missing, choose **Adjust GitHub App Permissions**,
   allow this repository, return, and select **Import**.
3. Set **Project Name** to an available name (for example `aegis-demo`). Select
   **Framework Preset → Other**. Set **Root Directory** to the repository root
   (`./`), **not** `apps/web`. Both the root `api/` folder and `vercel.json` must
   be included. Leave the build/output overrides off: the committed configuration
   supplies the install/build commands and `apps/web/dist` output directory.
4. Expand **Environment Variables** and enter the values in step 2 below before
   clicking **Deploy**. The initial deploy only hosts the website/functions; it
   does not deploy Solana programs or send transactions.
5. For the requested CLI login, in your own WSL terminal run:

   ```bash
   cd /home/thegoattsiklauri/Aegis
   pnpm dlx vercel login
   ```

   Follow the terminal's browser sign-in instructions. There is no need to run
   `vercel link` or `vercel deploy`: GitHub import and the dashboard deploy the
   project. If the CLI asks to create a project, cancel; this command is only login.

## 2. Paste environment variables privately

For an existing project, the page is **Vercel dashboard → your project → Settings →
Environment Variables → Add Environment Variable**. Select **Production**. Add
Preview only if you deliberately want preview URLs to spend the same demo agent's
SOL and use the same faucet allowance. Mark the three secrets **Sensitive** where
available. Never use a `VITE_` prefix, put secrets in GitHub, or paste values into
chat. Do not run the commands below in a recorded/shared terminal.

| Name | Value to paste |
| --- | --- |
| `GEMINI_API_KEY` | Your existing Google AI Studio Gemini API key. See below. |
| `AEGIS_AGENT_SECRET` | Entire JSON array printed by the devnet-agent command below. |
| `AEGIS_FAUCET_SECRET` | Entire JSON array printed by the devnet-faucet command below. |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` (not a secret; enables the pinned pnpm version). |

**Print the existing agent value yourself**, then copy the complete line, including
`[` and `]`, into `AEGIS_AGENT_SECRET`:

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(".keys/devnet-agent.json", "utf8"))) + "\n")'
```

**Print the dedicated faucet value yourself**, then copy the complete line
into `AEGIS_FAUCET_SECRET`:

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(".keys/devnet-faucet.json", "utf8"))) + "\n")'
```

Use the existing agent and dedicated faucet files; do not generate replacement
keys. The server checks their public keys against `deployments/devnet.json` and
checks that the faucet is the current testUSDC mint authority before every claim.
The faucet holds only testUSDC mint authority and SOL for ATA rent and fees.

**Never paste `.keys/devnet-deployer.json` anywhere, including Vercel, chat or
shared terminals. It is the programs’ upgrade authority and must never leave
this machine. `AEGIS_FAUCET_SECRET` must come only from `.keys/devnet-faucet.json`.**

Gemini is **not** in `.keys/`. Open https://aistudio.google.com/apikey, sign in,
and copy your existing key (or create a free-tier key yourself if needed). If
already saved in the repository's ignored `.env`, this optional command prints
only that value for you to paste into Vercel:

```bash
node -e 'process.loadEnvFile(".env"); if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing"); process.stdout.write(process.env.GEMINI_API_KEY + "\n")'
```

Clear your clipboard and terminal scrollback afterward. No key-copy command in
this guide has been run by the coding agent.

Optional variables, on the same settings page:

- `AI_MODEL`: a Gemini model ID, if your key needs a different model. Default:
  `gemini-3.1-flash-lite`. `AI_PROVIDER` is not needed; public live AI uses Gemini.
- `AEGIS_PUBLIC_ORIGIN`: the full canonical site URL, e.g.
  `https://aegis-demo.vercel.app`, with no path, query or credentials. Set this if
  using a custom domain, or if the automatic URL is unavailable. For the default
  Vercel domain it is inferred from Vercel's system variables. Open the site using
  this exact origin; aliases with other origins cannot perform browser writes.

Do not set `AEGIS_ENV`, `AEGIS_SIGNING`, `AEGIS_ACTIONS_DEPLOYMENT` or
`AEGIS_ACTIONS_ORIGIN` on Vercel. The public build forces devnet, Phantom signs owner
transactions, and public Actions use the committed devnet manifest.

## 3. Check deployment settings and publish

1. Click **Deploy** on the import page. Wait for **Ready**, then open the project.
2. Open **Settings → Build and Deployment**. Confirm **Root Directory** is `./`,
   **Framework Preset** is **Other**, and **Node.js Version** is **24.x**. Vercel
   manages the Node patch release; local checks use the pinned Node `24.10.0`.
   The repo pins pnpm `12.9.1`; do not replace it to fix a build failure.
   Also confirm **Settings → Functions → Fluid Compute** is enabled (the default
   for new projects). The function timeout is 180 seconds to allow Gemini plus
   devnet confirmation within the free plan limits.
3. Open **Settings → Git**, confirm `codalexic/Aegis` is connected and the production
   branch is `main` (shown under Production Branch / Production environment).
4. After adding/changing environment variables or settings, open **Deployments**,
   select the latest deployment's **… → Redeploy**, choose Production, and wait
   for **Ready**. Environment edits do not alter an already-built deployment.
5. Copy the public URL shown on **Overview**. If using a custom domain, add it in
   **Settings → Domains**, follow Vercel's DNS instructions, and set
   `AEGIS_PUBLIC_ORIGIN` to that exact URL, then redeploy.
6. Before sharing the link, complete the Firewall rule below. Then open
   **Settings → Deployment Protection** and ensure the **Production** URL can be
   accessed without a Vercel login. Keep preview protection if desired. If Actions
   return a Vercel sign-in page, production protection is still blocking them.

## 4. Enable the shared per-IP Firewall limit

In-memory counters alone cannot protect multiple serverless instances. This is a
required hosting step, not something `vercel.json` can provision without account
access. Vercel Hobby supports one rate-limit rule. Use it for all API POSTs:

1. Project → **Firewall → Configure → + New Rule**.
2. Name it `Aegis API writes`.
3. Add both conditions: **Request Path starts with `/api/`**, and **Request Method
   equals `POST`**. Both must match.
4. Under **Then**, choose **Rate Limit**. Choose **Fixed Window**, **Time Window:
   60 seconds**, **Request Limit: 6**, counting key **IP** only (not IP + path).
5. Choose the default **429** response. Do not select Log or Challenge.
6. Click **Save Rule → Review Changes → Publish**. Review the included Hobby
   allowance in Vercel; do not enable a paid plan for this demo.
7. Check **Firewall** traffic to confirm the rule is active. All agent, faucet and
   Actions POSTs share this allowance; GET/OPTIONS requests are unaffected.

The app additionally allows six agent requests/IP/minute, one faucet request/IP/
10 minutes, one claim/wallet/10 minutes and ten faucet claims/hour **per warm
instance**, reserving before RPC. Confirmed authority/account history also applies
faucet limits after restarts; other successful faucet transactions also count
toward the hourly cap, and recent recipient-account activity conservatively
starts the wallet cooldown. Pending claims on separate instances can race, and
Vercel WAF counters are per region. These are demo abuse controls, not a globally
atomic quota. Do not claim that one function instance or one region is guaranteed.
No database or new on-chain limiter is introduced in D3.

References: [Vercel rate-limit setup and limits](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting),
[Vercel environment settings](https://vercel.com/docs/environment-variables),
[Corepack setup](https://vercel.com/kb/guide/how-do-i-use-the-latest-npm-version-for-my-vercel-deployment).

## 5. Check devnet fee balances (public values only)

The agent and faucet pay their own transaction fees; Phantom pays owner fees.
These commands print only public addresses/balances:

```bash
solana address --keypair .keys/devnet-agent.json
solana balance --url devnet --keypair .keys/devnet-agent.json
solana address --keypair .keys/devnet-faucet.json
solana balance --url devnet --keypair .keys/devnet-faucet.json
```

If either balance is low, open https://faucet.solana.com, sign in yourself if
requested, and paste the corresponding public address to request free **devnet**
SOL. No SOL purchase is needed. Get devnet SOL for your Phantom wallet there too.

## 6. Public acceptance test with Phantom

1. Install Phantom from https://phantom.com/download. In Chrome, open
   `chrome://extensions`, find Phantom → **Details → Allow in Incognito**. In
   another browser, enable the equivalent permission for private windows.
2. Open a new private window, open Phantom → **Settings → Developer Settings →
   Testnet Mode**, and select **Solana Devnet**. Unlock your wallet. Keep the
   recovery phrase inside your wallet setup; never send it to Aegis.
3. Open the public Production URL. It must load without a Vercel login and show
   **DEVNET** plus the **How to try it** box.
4. Click **Connect wallet**, approve connection, then **Get 1,000 testUSDC**.
   A second immediate faucet request should show a limit message.
5. Click **New demo vault**. Approve creation, then funding, in Phantom. The page
   should show 1,000 testUSDC, cap 50, budget 100, and about one hour remaining.
6. In **Live AI**, run a normal trade (usually 20), then inject malicious news.
   A full 1,000 proposal must fail with `CapExceeded`. If Gemini has no quota,
   returns 5xx, or resists the injection, use **Scripted** to reproduce the story.
7. In **Scripted**, click **Hacker redirect**; expect `AccountMismatch`.
8. Click **Revoke agent**, approve in Phantom, then run a scripted normal trade;
   expect `Revoked`. Click **Withdraw all** and approve each available token
   withdrawal. Balances should reach zero. Explorer links must use `cluster=devnet`.
9. If the Firewall returns 429, wait at least a minute before continuing. Faucet
   limits may require ten minutes or an hour. Reloading cannot reset chain history.

Phantom reference: [developer settings](https://help.phantom.com/articles/28951369255699).

## 7. Check public HTTP responses outside the dashboard

In your own terminal, replace the URL below with your public URL. These first
requests do not send transactions or use any private values:

```bash
AEGIS_SITE='https://YOUR-PROJECT.vercel.app'
curl -i "$AEGIS_SITE/api/agent/info"
curl -i "$AEGIS_SITE/api/deployment"
curl -i "$AEGIS_SITE/api/owner/create"
curl -i "$AEGIS_SITE/actions.json"
curl -i "$AEGIS_SITE/api/actions/create"
curl -i -X OPTIONS "$AEGIS_SITE/api/actions/create"
```

Expect 200 JSON on info/deployment, devnet in both responses, 404 JSON on the
owner endpoint, action rules at `/actions.json`, and Actions/CORS headers with
`X-Blockchain-Ids: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. OPTIONS returns 204.

For an actual agent JSON check, create a fresh funded demo vault first. Copy its
full **public vault address** from the dashboard's Vault address (hover reveals
it), replace the value below, and run this yourself. It performs one real devnet
20 testUSDC swap and spends the server agent's transaction fee:

```bash
AEGIS_VAULT='PASTE_FULL_PUBLIC_VAULT_ADDRESS'
curl -i -X POST "$AEGIS_SITE/api/agent/normal" \
  -H 'Content-Type: application/json' -H 'X-Aegis-Agent: devnet' \
  --data "{\"live\":false,\"vault\":\"$AEGIS_VAULT\"}"
```

Expect 200 with a `steps` array containing a successful devnet result. No Origin
header is required for curl. Only vaults authorizing the configured server agent
are accepted. If the vault is already revoked, use a fresh vault to see success.

## 8. Check Actions on dial.to (manual wallet approvals)

1. In a normal browser tab, use Phantom on devnet with some devnet SOL and
   testUSDC left in the wallet. If needed, use the dashboard faucet first.
2. In WSL, run this (it prints four public links, no secrets):

   ```bash
   node -e 'for (const action of ["create", "fund", "revoke", "withdraw"]) console.log("https://dial.to/?action=" + encodeURIComponent("solana-action:" + process.argv[1] + "/api/actions/" + action) + "&cluster=devnet")' "$AEGIS_SITE"
   ```

3. Open the create link, keep/default cap 50 and budget 100, connect Phantom and
   approve the transaction. Reload the dashboard with the same wallet; this new
   vault must appear as the latest confirmed vault.
4. Open the fund link, enter `1000`, approve. Open revoke and approve. Open
   withdraw and approve; all available token balances return to your wallet.
   Each link must render the Aegis PNG logo, title and action button.
5. Optional, after the checks pass: follow the official
   [Dialect registry instructions](https://docs.dialect.to/docs/actions-and-blinks)
   to submit your public Actions URL for unfurling. Sign in/submit yourself.
   Registry approval is optional and does not block D3.

## 9. Check the exact deployed browser assets

Local checks include `node apps/web/scripts/scan-secrets.mjs`. To check the deployed
version too, open the public site's **View page source**, find its
`/assets/index-….js` filename, and download that JavaScript to a temporary folder:

```bash
AEGIS_ASSET='/assets/PASTE_THE_EXACT_JAVASCRIPT_FILENAME.js'
AEGIS_SCAN_DIR=$(mktemp -d)
curl --fail --silent --show-error "$AEGIS_SITE$AEGIS_ASSET" -o "$AEGIS_SCAN_DIR/bundle.js"
node apps/web/scripts/scan-secrets.mjs "$AEGIS_SCAN_DIR"
```

Repeat the download for every script/chunk in the deployed page if there is more
than one. The scanner prints filenames/categories only, never matching values;
it checks tracked files plus the downloaded assets against credential patterns
and existing local key/API-key values. A PASS for local `dist` alone does not prove
which build Vercel deployed. Record the public URL and these manual results to
finish D3's public acceptance check.
