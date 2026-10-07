# Localnet SDK checks (C5)

Keep `pnpm localnet` running in another terminal, then run from the repository root:

```bash
pnpm test:e2e
pnpm exec tsc -p tests/e2e/tsconfig.json
```

These nine cases cover INTERFACES §8 through the real `AnchorAegisClient`.
Expiry remains covered by P6's LiteSVM clock tests. Rejections must report the
exact error with `origin: "program"`, appear in RPC activity, and preserve both
vault balances, spent, policy and pool reserves. Redirection uses `swapRaw` with
an initialized attacker token account for the correct mint.

Tests read the public deployment and the ignored owner/agent test keys. Each
case creates a fresh random nonzero vault ID with cap 50, budget 100 and one-hour
expiry, mints 1,000 testUSDC, then funds through the SDK. This permits reruns on
the same chain without spending the dashboard's token supply or reusing its
vault. Test vaults remain on localnet; the tests do not reset the validator or
change `deployments/localnet.json`. Real local transaction fees and rent use the
seeded test keys. No AI provider is called.

The budget case waits for a fresh blockhash between identical swaps so it sends
six distinct transactions. It checks every successful balance/spent increment
and all five success signatures before asserting the sixth rejection.
