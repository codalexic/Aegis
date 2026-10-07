# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code) working in this repository.

## Project

Aegis is a three-day Solana demo: an AI agent trades from a vault, and an on-chain program enforces a per-trade cap, total budget, expiry, revocation and a fixed destination. Read these before writing code:

1. [AEGIS_PLAN.md](AEGIS_PLAN.md) — what we build and what we do not.
2. [docs/planning/INTERFACES.md](docs/planning/INTERFACES.md) — exact accounts, instructions, errors, SDK types. **This is the spec.**
3. [docs/planning/CODEX_TASKS.md](docs/planning/CODEX_TASKS.md) — ordered tasks with completion checks.

Do one task from `CODEX_TASKS.md` at a time. When its "Done when" check passes, stop and report what you did and the command output.

## Environment

- Run everything inside **WSL (Ubuntu)**, not Windows PowerShell. Anchor does not build natively on Windows.
- Toolchain versions are pinned in `Anchor.toml` (`[toolchain]`), `rust-toolchain.toml` and `package.json` (`packageManager`, `engines`). Use what is pinned; never upgrade a version to fix an error without saying so.
- Package manager: **pnpm**. Do not create `package-lock.json` or `yarn.lock`.

## Commands

| Command | What it does |
| --- | --- |
| `anchor build` | Build both programs; writes `target/deploy/*.so`, `target/idl/*.json`, `target/types/*.ts` |
| `pnpm idl:sync` | Copy IDL and types from `target/` to `artifacts/idl/` |
| `pnpm test:program` | Program tests in `tests/program` (LiteSVM, no validator needed) |
| `pnpm localnet` | Start `solana-test-validator` with both programs preloaded, seed tokens, pool and test keys, write `deployments/localnet.json` |
| `pnpm test:e2e` | SDK tests in `tests/e2e` against a running `pnpm localnet` |
| `pnpm test:sdk` | SDK unit tests (mock client, conversions) |
| `pnpm dev` | Dashboard at http://localhost:5173 |
| `pnpm agent --mode normal\|injected\|attacker\|scripted` | Run the AI agent |
| `pnpm demo` | Run the full demo story in the terminal |

## Rules

- **Scope:** build only what `AEGIS_PLAN.md` §2 lists. No ZK, Jupiter, devnet, nonces, slippage settings, backend server, database or browser wallet.
- **Security checks are the product.** Never remove, weaken or skip a check in `programs/aegis` to make a test pass. If a test fails, fix the code or report the problem.
- **Amounts:** `u64` with checked arithmetic in Rust; `bigint` in TypeScript. Never pass token amounts through JavaScript `number`.
- **Keys:** only in `.keys/` (git-ignored). Never commit, log or print a secret key. Never send a key to an AI model. The browser bundle never contains a key.
- **IDL:** generated only. Never hand-edit files in `artifacts/idl/` or `target/`.
- **Mock labelling:** anything from `MockAegisClient` is shown as `mock`; never fabricate signatures that look real.
- **One operator:** one person runs every task in order (P0–P6, then C0–C7). You may change any file a task needs, but stay within that task's scope and do not refactor unrelated code.
- Keep code small and readable. No extra abstractions, frameworks or dependencies beyond what a task needs.

## Layout

```
Anchor.toml  Cargo.toml  rust-toolchain.toml  package.json  pnpm-workspace.yaml
programs/aegis/        programs/demo_dex/
tests/program/         tests/e2e/
packages/sdk/          apps/web/
scripts/localnet/      scripts/agent/      scripts/demo/
artifacts/idl/         deployments/        .keys/ (ignored)
```
