# Mariam: Programs (24 hours)

Mariam builds the two Solana programs, their tests and the local chain script, and owns `programs/`, `tests/program/`, `artifacts/idl/`, `deployments/` and `scripts/localnet/`. Follow [INTERFACES.md](INTERFACES.md).

These two handoffs unblock Alexis, so they have fixed times: **H1 at Day 1 hour 3** and **H2 at Day 2 hour 6**. Ship them on time even if something else is unfinished.

**Before Day 1:** Rust, Solana CLI and Anchor working in WSL, versions pinned. Confirm with `anchor test` on a sample project.

## Day 1

**Hour 1 — M-1 with Alexis.** Approve the interface.

**Hours 2–3 — Skeleton and IDL (H1).** Create the Anchor workspace with `aegis` and `demo_dex`. Write all instructions with final arguments and account structs and empty bodies, plus the error enum. Build and commit the IDL to `artifacts/idl/`.

**Hours 4–8 — Vault lifecycle.** Implement `create_vault`, `revoke_agent` and `withdraw` with all account and signer checks. Tests in `tests/program/` using **LiteSVM** (fast, and it can move the clock for expiry tests):

- create, fund by transfer, read state;
- owner withdraws; agent cannot withdraw;
- revoke works and is permanent;
- owner withdraws after revoke.

*Plan B check at hour 6: if create or withdraw still fails, ask for help now.*

## Day 2

**Hours 1–4 — Test exchange and swap.** `demo_dex::initialize_pool` and `demo_dex::swap` (INTERFACES §4): swap takes input tokens from the caller and sends `amount × 10` output tokens from the pool. `aegis::execute_swap`: all checks from INTERFACES §3, the call into `demo_dex` signed by the vault authority, and the balance check afterwards. Tests: normal 20 swap, 60 rejected, redirect rejected.

*Plan B check at hour 4: if the call into `demo_dex` does not work, replace the swap with a payment to a fixed merchant account (same checks) and tell Alexis in writing.*

**Hours 5–6 — Local chain script (H2).** `pnpm localnet` (`scripts/localnet/start.ts`): start a validator, deploy both programs, create the two test mints, create and fund the pool, create and fund test owner and agent keypairs in `.keys/`, write `deployments/localnet.json`. Test it from a clean clone, then hand it off.

**Hour 7 — Attack tests.** Start on the remaining cases in INTERFACES §8.

**Hour 8 — M-2 with Alexis.** First real swap through Alexis's SDK.

## Day 3

**Hours 1–3 — Finish attack tests.** Every case in INTERFACES §8 passes, including expiry (move the clock) and five-then-sixth budget. Failed swaps leave balances and `spent_raw` unchanged.

**Hour 4 — Fixes** from M-2 and Alexis's notes. Commit final IDL.

**Hours 5–8 — M-3 with Alexis.** Freeze at hour 5. Rehearse, record the backup video, final clean-clone run.
