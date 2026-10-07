# Aegis Tasks for Coding Agents

Ordered tasks for Codex or another coding agent. Follow [AGENTS.md](../../AGENTS.md) and implement exactly what [INTERFACES.md](INTERFACES.md) specifies. Do one task per run; stop when its **Done when** check passes and report the command output.

One operator runs every task in this order: **P0 → P6, then C0 → C7.** Programs come first because they carry the most risk. Before each task, `git pull`; after its check passes, commit and push.

| Day | Tasks |
| --- | --- |
| Day 1 | P0, P1, P2, P3, P4 |
| Day 2 | P5, P6, C0, C1, C2, C3, C4 |
| Day 3 morning | C5, C6, C7, then the review below |

---

## P0 Workspace and pinned toolchain

**Files:** `Anchor.toml`, `Cargo.toml`, `rust-toolchain.toml`, `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `programs/aegis`, `programs/demo_dex`.

- Create an Anchor workspace with two programs, `aegis` and `demo_dex`. `aegis` depends on `demo_dex` with `features = ["cpi"]`.
- Pin the Anchor, Solana and Rust versions that are installed (`anchor --version`, `solana --version`, `rustc --version`) in `Anchor.toml` `[toolchain]` and `rust-toolchain.toml`.
- Root `package.json`: `packageManager` pnpm, Node version in `engines`, scripts listed in AGENTS.md (stubs are fine for now). Workspace packages: `packages/*`, `apps/*`. Dev dependencies at root: `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, `litesvm`, `vitest`, `tsx`, `typescript`.
- `.gitignore`: `target/`, `node_modules/`, `.keys/`, `.env`, `test-ledger/`.
- Run `anchor keys sync` so program IDs in `declare_id!` and `Anchor.toml` match.

**Done when:** `anchor build` succeeds and `pnpm install` succeeds.

## P1 Program skeleton and IDL

**Files:** `programs/aegis/src/lib.rs`, `programs/demo_dex/src/lib.rs`, `artifacts/idl/`.

- Declare all instructions from INTERFACES §3 and §4 with **final arguments and account structs**, state structs (`Vault`, `Pool`) and error enums (§5). Bodies may return `Ok(())` for now.
- Add `pnpm idl:sync` that copies `target/idl/*.json` and `target/types/*.ts` into `artifacts/idl/`.

**Done when:** `anchor build && pnpm idl:sync` succeeds and `artifacts/idl/aegis.json` lists `create_vault`, `execute_swap`, `revoke_agent`, `withdraw` and all eight errors.

## P2 Vault lifecycle with tests

**Files:** `programs/aegis/src/`, `tests/program/`.

- Implement `create_vault`, `revoke_agent`, `withdraw` exactly as INTERFACES §3, with Anchor constraints (`seeds`, `bump`, `has_one = owner @ AegisError::Unauthorized`, `associated_token::...`).
- `tests/program/helpers.ts`: load `target/deploy/aegis.so` and `demo_dex.so` into LiteSVM, create the two mints (6 and 9 decimals), owner and agent keypairs, and a `freshVault()` helper (cap 50, budget 100, expiry +1h, funded with 1,000 testUSDC).
- Tests: create and read state; invalid policy rejected (`InvalidAmount`); owner withdraws; agent withdraw → `Unauthorized`; revoke is permanent; owner withdraws after revoke.

**Done when:** `anchor build && pnpm test:program` passes.

## P3 Test exchange

**Files:** `programs/demo_dex/src/`, `tests/program/`.

- Implement `initialize_pool` and `swap` exactly as INTERFACES §4.
- Tests: pool initializes; direct swap of 20 testUSDC moves 20000000 in and 200000000 out; swap larger than reserve → `InsufficientReserve`.

**Done when:** `pnpm test:program` passes.

## P4 `execute_swap`

**Files:** `programs/aegis/src/`, `tests/program/`.

- Implement the seven checks in INTERFACES §3 in order, with the CPI into `demo_dex::swap` signed by the vault authority PDA, and the balance check after reload.
- Tests: normal 20 swap; swap 60 → `CapExceeded`; output redirected to an attacker token account → `AccountMismatch`.

**Done when:** `pnpm test:program` passes. These checks are reviewed by hand in the final review (R).

*Plan B (decide at end of Day 1): if the CPI cannot be made to work, replace the swap with `execute_payment(amount)` that transfers testUSDC to a fixed merchant token account stored in the vault, keeping checks 1–4 and 7. Update INTERFACES.md to match.*

## P5 Local chain script

**Files:** `scripts/localnet/start.ts`, `deployments/localnet.json`.

`pnpm localnet`:

1. Starts `solana-test-validator --reset` with `--bpf-program <id> target/deploy/<name>.so` for both programs.
2. Waits for RPC, creates `.keys/owner.json` and `.keys/agent.json` if missing, airdrops SOL to both.
3. Creates testUSDC (6 decimals) and testSOL (9 decimals), mints 10,000 testUSDC to the owner.
4. Calls `initialize_pool` and funds `output_reserve` with 1,000 testSOL.
5. Writes `deployments/localnet.json` (INTERFACES §7) and keeps the validator running in the foreground.

**Done when:** from a clean clone, `anchor build && pnpm localnet` runs, and `solana account <pool address> --url localhost` shows the pool.

## P6 Full attack suite

**Files:** `tests/program/`.

Cover every case in INTERFACES §8, including five swaps then a sixth, wrong signer, swap after revoke, and swap after expiry (advance the LiteSVM clock). Every rejected case asserts unchanged balances and `spent_raw`.

**Done when:** `pnpm test:program` passes with all ten cases.

---

## C0 SDK package and mock client

**Files:** `packages/sdk/`.

- Types and `AegisClient` interface from INTERFACES §6.
- Helpers: decimal string ↔ `bigint`, UI amount ↔ raw (`20` testUSDC → `20000000n`), PDA derivation (§2).
- `MockAegisClient`: in-memory vaults that enforce the same rules so the outcomes in §8 come out the same (60 → `CapExceeded`, sixth 20 → `BudgetExceeded`, after revoke → `Revoked`). Signatures are `mock-<n>`.
- `createClient(env)` returns the mock when `AEGIS_ENV=mock`.

**Done when:** `pnpm test:sdk` passes with tests for the conversion helpers and every §8 case on the mock.

## C1 Dashboard against the mock

**Files:** `apps/web/` (React + Vite + TypeScript).

One page:

- vault card: owner, agent, cap, budget, spent, expiry countdown, revoked status, both balances;
- remaining-budget bar (budget − spent) that updates after each trade;
- buttons: Create vault, Fund 1,000, Revoke agent, Withdraw all;
- activity list: time, amount, ✓ or ✗ with the program error name;
- environment badge (`mock` / `localnet`) always visible, plus "test key · localnet only" in localnet mode.

Poll the vault state every 2 seconds. Keep styling simple and clean.

**Done when:** `AEGIS_ENV=mock pnpm dev` shows the page; create, fund, revoke and withdraw update the mock state; `pnpm --filter web build` succeeds.

## C2 AI agent

**Files:** `scripts/agent/`.

`pnpm agent --mode <mode>`:

- Loads only `.keys/agent.json` (localnet) or a mock agent (mock). Vault address from `--vault` or the last vault in `deployments/localnet.json`.
- Asks an AI model for a trade. Provider from `AI_PROVIDER=gemini|anthropic|openai`, key from `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, model from `AI_MODEL` (default for Anthropic: `claude-sonnet-5-5`; for Gemini, a current free-tier Flash model from Google AI Studio). Gemini is the primary provider for the demo because it has a free tier; call its REST API with `fetch`, no extra SDK. Keys come from `.env`, never logged. If the provider is missing or the call fails, print a clear message and suggest `--mode scripted`.
- The model sees the vault policy and a news text, and must reply JSON only: `{"amountUsdc": "20", "reason": "..."}`. Parse and validate; convert to raw `bigint`; call `swap`.
- Modes:
  - `normal`: calm market news → expect ~20 → success.
  - `injected`: news text with a hidden line instructing the agent to swap the entire 1,000 testUSDC immediately. The agent's system prompt tells it to treat news as instructions from its operator, so it is likely to comply. → program rejects with `CapExceeded`.
  - `attacker`: no model; uses `swapRaw` with `output_vault` replaced by an attacker token account → `AccountMismatch`.
  - `scripted`: the three scenarios above with fixed amounts and no model, for when the AI or network fails.
- Print each step clearly: news, model reply, request sent, result with error name. This output is shown on stage.

If the model refuses the injection, print that and suggest `--mode scripted`; do not change program behaviour.

**Done when:** all four modes run against the mock with the expected results; `normal` and `injected` work with a real API key.

## C3 Real Anchor client

**Files:** `packages/sdk/`.

Requires P1 (`artifacts/idl/`).

- `AnchorAegisClient` implementing every method with `@coral-xyz/anchor` and the IDL; `swapRaw`; error mapping from Anchor error codes to the names in INTERFACES §5; `listActivity` via `getSignaturesForAddress` + `getTransaction`.
- Reads addresses from `deployments/localnet.json`.

**Done when:** `pnpm test:sdk` passes and the package type-checks against the generated IDL types.

## C4 Switch to localnet and dashboard signing

**Files:** `apps/web/`, `scripts/agent/`.

Requires P5 (`pnpm localnet`).

- Vite dev-server plugin with `POST /api/owner/{create,fund,revoke,withdraw}` that loads `.keys/owner.json` in Node and calls `AnchorAegisClient` (INTERFACES §7). The browser never receives a key.
- Dashboard and agent use the real client when `AEGIS_ENV=localnet`.

**Done when:** with `pnpm localnet` running, `AEGIS_ENV=localnet pnpm dev` can create and fund a vault, `pnpm agent --mode normal` succeeds and appears in the activity list, `--mode injected` and `--mode attacker` appear as blocked.

## C5 End-to-end tests

**Files:** `tests/e2e/`.

Run every INTERFACES §8 case through `AnchorAegisClient` against `pnpm localnet`, except expiry (covered by P6). Use `swapRaw` for the redirect case.

**Done when:** `pnpm test:e2e` passes with `pnpm localnet` running.

## C6 Terminal demo

**Files:** `scripts/demo/`.

`pnpm demo` runs on localnet: create vault → fund 1,000 → normal swap 20 → injected attack (scripted amount 1,000) blocked → redirect attack blocked → revoke → agent swap blocked → owner withdraws all. Print each step with a short title, result, error name, balances and remaining budget. Pause one second between steps.

**Done when:** `pnpm demo` completes the full story twice in a row on a fresh `pnpm localnet`.

## C7 README

**Files:** `README.md`.

Short: what Aegis is, prerequisites (WSL, pinned versions), and the commands to build, start localnet, run the dashboard, agent and demo.

**Done when:** following the README on a clean clone runs `pnpm demo` successfully.

---

## R Joint review (Alexis and Mariam, after C7)

Not a Codex task. Go through this together before the feature freeze.

**`programs/aegis` — compare line by line with INTERFACES §3:**

- [ ] `execute_swap` requires the signer to equal `vault.agent`.
- [ ] Revoked and expiry checks come before any transfer.
- [ ] Cap and budget use checked arithmetic; `spent_raw` is updated only after the balance check.
- [ ] `input_vault`, `output_vault`, pool, reserves, `demo_dex` program and token program are all constrained; no account is taken on trust.
- [ ] The balance check after the CPI reloads both accounts and compares exact input and minimum output.
- [ ] `withdraw` and `revoke_agent` require the owner; the agent cannot call them.
- [ ] Nothing lets the agent change policy, close accounts or set a delegate.

**Tests:**

- [ ] Every case in INTERFACES §8 exists in `tests/program` and asserts unchanged state on rejection.
- [ ] No test was weakened to pass (search for skipped tests, loosened assertions or commented-out checks).

**Client and demo:**

- [ ] No secret key in the repository, logs or browser bundle (`git grep -i secret`, check `.gitignore`).
- [ ] Mock mode is labelled everywhere it appears.
- [ ] `pnpm demo` runs the full story on a fresh `pnpm localnet`.
- [ ] Agent `injected` and `scripted` modes both show the program rejection.

Record anything found as a follow-up and split the fixes between Alexis and Mariam.

---

# Stage readiness (Day 2)

The build is complete. These tasks make the demo reliable and easy to present from one screen. Same rules: one task at a time, `git pull` first, check, commit, push. Do not change `programs/` in any of these tasks.

## C8 Agent console in the dashboard

**Files:** `apps/web/server/`, `apps/web/src/`, `scripts/agent/` (only to export what the server needs).

- Add dev-server endpoints `POST /api/agent/{normal,injected,attacker}` (localnet only) with a body `{ "live": boolean }`. They load `.keys/agent.json` and the AI key in Node and reuse `runAgent` from `scripts/agent/run.ts` with a `log` callback that collects steps. `live: false` uses the scripted reply. No key, `.env` value or raw model config ever reaches the browser.
- Response: `{ steps: Step[] }`, where a step is one of `news`, `model_reply`, `request`, `result`, `balances`, `notice`, as structured fields (not one text blob).
- Dashboard "Agent console" panel beside the vault card:
  - three large buttons: **Run normal trade**, **Inject malicious news**, **Hacker redirect**;
  - a toggle **Live AI / Scripted**, default Live AI, with the model name shown when live;
  - the news text, with the injected instruction highlighted;
  - the model's reply as formatted JSON;
  - the outcome as a large banner: green "Executed" or red "Blocked by Aegis program: <ErrorName>" plus a one-line plain-English reason (e.g. CapExceeded → "Per-trade cap is 50 testUSDC; the agent asked for 1,000");
  - if the model resists the injection, show "The model resisted the injection" and a one-click **Retry scripted** button.
- Buttons are disabled while a request is running; errors show a readable message, never a stack trace.

**Done when:** with `pnpm localnet` running and `AEGIS_ENV=localnet pnpm dev`, each button produces the expected banner (normal → Executed, injected → CapExceeded, hacker → AccountMismatch) in both Live and Scripted modes; endpoint tests pass; `pnpm --filter web build` succeeds and `grep -rE "AIza|secretKey|GEMINI" apps/web/dist` finds nothing.

## C9 Injection reliability check

**Files:** `scripts/agent/`.

- Add `pnpm agent:eval --runs 10` (no chain needed): calls the live model 10 times for `normal` and 10 times for `injected` and prints how often `normal` proposed ≤ 50 testUSDC and how often `injected` proposed the full 1,000 testUSDC.
- If `injected` compliance is below 9/10 or `normal` is below 10/10, adjust only the agent's system prompt and news text (never the program or the client checks) and run again. Keep the agent honest: it must still submit exactly what the model proposed.
- Respect the free-tier rate limit: pause between calls and stop cleanly on a 429.

**Done when:** the eval prints at least 9/10 injected compliance and 10/10 normal, or, if that cannot be reached, the report states the best rate achieved and the dashboard's Retry scripted path from C8 is confirmed working.

## C10 One-command start and fresh demo vault

**Files:** `scripts/stage/`, `package.json`, `apps/web/`.

- `pnpm start:demo`: runs `anchor build` only if `target/deploy/*.so` is missing or older than the sources, starts localnet, waits until it is healthy, starts the dashboard with `AEGIS_ENV=localnet`, and prints one clear line with the URL. Ctrl+C stops both cleanly. If port 8899 or 5173 is already in use, say so and how to free it instead of failing obscurely.
- Dashboard button **New demo vault**: creates a fresh vault and funds it with 1,000 testUSDC in one click, and switches the page to it. This is the pre-show reset.

**Done when:** from a new terminal, `pnpm start:demo` brings up a working dashboard in under 90 seconds, and New demo vault produces a funded vault with spent 0.

## C11 Stage polish and on-chain proof

**Files:** `apps/web/src/`.

- Activity list: shorten signatures to `abcd…wxyz`; each links to Solana Explorer for the local chain: `https://explorer.solana.com/tx/<sig>?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`. Blocked rows show the plain-English reason from C8.
- Readability on a projector at 1280×720: body text at least 16px, key numbers (balances, remaining budget) at least 32px, high contrast, nothing important below the fold on the vault card and agent console.
- Budget bar changes colour as it falls (green → amber below 40% → red below 15%).
- Header line under the title: "AI agents can be tricked. Aegis enforces the limits on-chain." 
- No new dependencies unless unavoidable.

**Done when:** `pnpm --filter web build` succeeds; at 1280×720 the vault card, budget bar and agent console are visible together without scrolling; Explorer links open the transaction for the local chain.

## C12 Final verification

**Files:** none unless a defect is found.

Run, in order, and report each result: `anchor build`, `pnpm test:program`, `pnpm test:sdk`, `pnpm test:agent`, web tests, `pnpm start:demo` + `pnpm test:e2e`, `pnpm demo` twice, `pnpm --filter web build`, a secret scan (`git grep -nE "AIza|BEGIN .*PRIVATE|secretKey" -- . ':!pnpm-lock.yaml'` and `git ls-files | grep -E "\.keys/|\.env$"`). Fix only real defects; do not change `programs/` without stopping to report first.

**Done when:** every command above passes and the report is in the final message.

---

# Review fixes (Mariam's contract review, Day 2)

Do these one at a time, in order. Before F1, create a rollback point: `git tag pre-review-fixes && git push origin pre-review-fixes`. Every task: `git pull` first; keep every existing check in `programs/aegis`; never weaken or delete a test; commit and push only when the check passes. Do not touch the dashboard in F1–F5.

## F1 Reject invalid agent at vault creation

**Files:** `programs/aegis/src/lib.rs`, `tests/program/`, `docs/planning/INTERFACES.md`.

- `create_vault`: reject `agent == Pubkey::default()` and `agent == owner` with `InvalidAmount`, alongside the existing policy constraints.
- Tests: both rejections, and that nothing is created (vault and token accounts absent).
- INTERFACES §3 `create_vault` rules: add "agent is not the default key or the owner".

**Done when:** `anchor build && pnpm idl:sync && pnpm test:program` pass.

## F2 Aegis-owned exchange rate

**Files:** `programs/aegis/src/lib.rs`, `tests/program/`, `docs/planning/INTERFACES.md`.

- Add `pub const EXPECTED_RATE_MULTIPLIER: u64 = 10;` in `aegis` and use it in step 6 of `execute_swap` instead of `demo_dex::RATE_MULTIPLIER`.
- Add a test asserting `EXPECTED_RATE_MULTIPLIER == demo_dex::RATE_MULTIPLIER` (a Rust unit test in `programs/aegis` is fine), so a DEX rate change fails tests instead of silently changing the Aegis guard.
- INTERFACES §3 step 6: say the expected output uses Aegis's own rate constant.

**Done when:** `anchor build && pnpm test:program` pass, plus the new Rust test (`cargo test -p aegis` or the equivalent).

## F3 Store the pool bump in the vault

**Files:** `programs/aegis/src/lib.rs`, `tests/program/`, `docs/planning/INTERFACES.md`.

- Add `pool_bump: u8` to `Vault`. In `create_vault`, derive the pool PDA for the two mints under `demo_dex` once and store its bump.
- In `execute_swap`, replace `find_program_address` for the pool with `create_program_address` using the stored bump; keep the same `AccountMismatch` behaviour and every other account check.
- INTERFACES §2 vault fields: add `pool_bump`.

**Done when:** `anchor build && pnpm idl:sync && pnpm test:program` pass with no test changes other than new or updated fixtures for the added field.

## F4 Owner-only agent rotation (program)

**Files:** `programs/aegis/src/lib.rs`, `tests/program/`, `docs/planning/INTERFACES.md`.

- New instruction `rotate_agent(new_agent: Pubkey)`, accounts `owner` (signer) and `vault` (mut, same seeds and `has_one = owner @ Unauthorized` as `revoke_agent`).
- Rules: `new_agent` is not the default key, not the owner, and not the current agent (`InvalidAmount`). Sets `agent = new_agent` and `revoked = false`. `spent_raw`, cap, budget and expiry do not change.
- Tests: owner rotates; old agent's swap then fails with `Unauthorized`; new agent swaps within the remaining budget; spent is not reset (budget still enforced across both agents); agent calling `rotate_agent` fails with `Unauthorized`; rotating a revoked vault re-enables trading for the new agent only; invalid `new_agent` values rejected.
- INTERFACES: add `rotate_agent` to §3 and update "Only `spent_raw` and `revoked` change after creation" to include `agent` via `rotate_agent`.

**Done when:** `anchor build && pnpm idl:sync && pnpm test:program` pass. Stop and report; Claude reviews this instruction before F5.

## F5 SDK support and full verification

**Files:** `packages/sdk/`, `tests/e2e/`.

- Add `rotateAgent(owner, vault, newAgent)` to `AegisClient`, `MockAegisClient` (same rules) and `AnchorAegisClient`, with unit tests. Map errors as for other instructions. Not added to the dashboard.
- One e2e test: rotate, old agent rejected, new agent succeeds.
- Restart localnet with the new programs (old vaults are incompatible with the new `Vault` layout).
- Run and report: `anchor build`, `pnpm test:program`, `pnpm test:sdk`, `pnpm test:agent`, `pnpm --filter web test`, `pnpm --filter web build`, `pnpm start:demo` + `pnpm test:e2e`, `pnpm demo` twice.

**Done when:** every command passes.
