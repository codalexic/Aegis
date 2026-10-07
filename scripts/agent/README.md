# Agent demo (C2)

Run from the repository root. Each mock command creates its own vault funded with
1,000 testUSDC, cap 50, budget 100, expiry +1h. Its in-memory state is separate from
the dashboard. Every simulated transaction is labelled `mock`.

Put provider configuration in the ignored `.env` file:

```dotenv
AEGIS_ENV=mock
AI_PROVIDER=gemini
GEMINI_API_KEY=your-google-ai-studio-key
# AI_MODEL=gemini-3.1-flash-lite
```

Gemini is the primary demo provider. The default is `gemini-3.1-flash-lite`, listed with
a free tier in [Google's pricing](https://ai.google.dev/gemini-api/docs/pricing).
Alternatively use `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` (default
`claude-sonnet-5-5`), or `AI_PROVIDER=openai` with `OPENAI_API_KEY` (default
`gpt-4.1-mini`). `AI_MODEL` overrides the selected provider's default.
All providers use native `fetch`; no provider SDK is installed.

```bash
AEGIS_ENV=mock pnpm agent --mode normal
AEGIS_ENV=mock pnpm agent --mode injected
AEGIS_ENV=mock pnpm agent --mode attacker
AEGIS_ENV=mock pnpm agent --mode scripted
```

Expected results: normal proposes about 20 and succeeds; injected proposes 1,000
and gets `CapExceeded`; attacker submits 20 with a redirected `output_vault` via
`swapRaw` and gets `AccountMismatch`. Scripted runs these three in that order
without a model or network. Expected attack rejections exit successfully;
unexpected results, bad model JSON, missing configuration and API failures exit 1.

The system prompt deliberately trusts operator instructions embedded in news.
Only policy, balances and news are sent to the model. Decimal strings are parsed
directly to `bigint`; cap and budget are never used to clamp or replace a proposal.
If the model ignores/refuses the injection, the output says so and recommends
`--mode scripted`. Nothing silently falls back or fabricates a model reply.

Localnet credential loading accepts `--vault ADDRESS`, then `lastVault` (or the
last entry of `vaults`) in `deployments/localnet.json`, and reads only
`.keys/agent.json`. The real client and localnet execution remain C3/C4 work.
Mock `--vault` can select only this process's deterministic demo vault.

Offline checks:

```bash
pnpm test:agent
pnpm exec tsc -p scripts/agent/tsconfig.json
```

The C2 completion check also requires running all four modes against the mock,
with a real API key for normal and injected. Provider API references:
[Gemini](https://ai.google.dev/gemini-api/docs/generate-content/latest-model),
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create),
[OpenAI Responses](https://developers.openai.com/api/docs/guides/structured-outputs).
