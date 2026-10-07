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

D1 tooling is ready; public deployment and the devnet 8/8 demo still require
funding. The dashboard remains localnet/mock until D2.

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
and `.keys/devnet-deployer.json` as upgrade/mint authority, creates testUSDC (6
decimals) and testSOL (9), seeds 100,000 testSOL in the pool and 10,000 testUSDC
for the owner, and funds `.keys/devnet-agent.json`. Reruns reuse mints/pool,
skip identical binaries and top up only missing balances. Upload buffer keys
are preserved for resuming failures. Run one deployment process at a time.

Successful setup writes public addresses to `deployments/devnet.json`. Pass it
to the SDK with `createClient("devnet", { deployment })`. The agent uses only the
devnet agent key; the demo also uses the deployer. RPC retries use bounded backoff
and identical signed bytes. Signatures link to Explorer with `?cluster=devnet`.
Localnet defaults and loopback restrictions are preserved.

With localnet running, `pnpm test:devnet` checks the funding gate, key reuse and
seeding twice on the local validator. It spends no public devnet SOL.
