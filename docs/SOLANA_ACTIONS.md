# Solana Actions (Blinks)

Every owner operation is also exposed as an unsigned Solana Action, so a vault can
be created, funded, revoked and emptied from any Actions-aware wallet or Blink.

## Running locally

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

To try the deployed Actions, open each action URL with Phantom on devnet using
`https://dial.to/?action=solana-action:<encoded HTTPS action URL>&cluster=devnet`.
Create a vault, fund it, revoke the agent, then withdraw. Reload the dashboard
with the same wallet to see the latest confirmed vault. For optional link
unfurling, submit the public Actions URL through the
[Dialect registry](https://docs.dialect.to/docs/actions-and-blinks).
Automated local checks require no public transactions.
