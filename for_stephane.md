# Aegis — მოკლე აღწერა Stephane-სთვის

## რა პრობლემას ვაგვარებთ

AI აგენტებს სულ უფრო ხშირად აძლევენ wallet-ის key-ს, რომ დამოუკიდებლად ივაჭრონ. პრობლემა ისაა, რომ აგენტის მოტყუება მარტივია: ერთი prompt injection და აგენტი მთელ ბალანსს გადაცვლის ან სხვა მისამართზე გადარიცხავს. off-chain შეზღუდვები აქ არ შველის, რადგან ისინი იმავე კოდში არსებობს, რომელიც მოატყუეს.

Aegis-ში შეზღუდვები on-chain, Solana-ს პროგრამაშია. თანხა PDA vault-ზეა, owner ლიმიტებს ერთხელ აწესებს და agent მხოლოდ ამ ლიმიტების ფარგლებში მოქმედებს. რასაც არ უნდა მოითხოვდეს agent, პროგრამა არ გაატარებს.

## როგორ მუშაობს

vault-ის შექმნისას (`create_vault`) owner განსაზღვრავს:
- ერთი trade-ის მაქსიმალურ თანხას (cap)
- ჯამურ ბიუჯეტს (budget); `spent_raw` არასდროს ნულდება
- მოქმედების ვადას (expiry, chain clock-ით)

agent-ს მიმღების არჩევა არ შეუძლია, მხოლოდ თანხას უთითებს. swap-ის შედეგი ყოველთვის იმავე vault-ში ბრუნდება.

owner-ს ნებისმიერ დროს შეუძლია agent-ის გათიშვა (`revoke_agent`), ჩანაცვლება (`rotate_agent`) და თანხის გატანა (`withdraw`), მათ შორის revoke-ის ან expiry-ს შემდეგაც.

`execute_swap`-ის შემოწმებები, თანმიმდევრობით: signer == agent → არ არის revoked და expired → amount > 0, ≤ cap, spent + amount ≤ budget (checked) → ყველა account (vault-ის ATA-ები, pool PDA, reserves, programs) → `demo_dex::swap`-ის CPI vault PDA-ის ხელმოწერით → reload და რეალური ბალანსების შედარება (input ზუსტად amount, output ≥ amount × 10) → მხოლოდ ამის შემდეგ `spent_raw += amount`. ნებისმიერ ეტაპზე შეცდომა მთელ ტრანზაქციას აუქმებს.

`demo_dex` ჩვენივე სატესტო DEX-ია: ერთი pool, ფიქსირებული rate (100 testUSDC = 1 testSOL), ნამდვილი SPL transfer-ებით. Jupiter და price oracle ჯერ არ გვაქვს.

## სტრუქტურა

```
programs/aegis/        მთავარი პროგრამა (Anchor) — დაიწყე execute_swap-ით
programs/demo_dex/     სატესტო DEX
tests/program/         პროგრამის ტესტები (LiteSVM, expiry clock warp-ით)
packages/sdk/          TypeScript SDK: mock და Anchor client, თანხები bigint-ით
apps/web/              dashboard (React + Vite) და server endpoint-ები
scripts/agent/         AI agent (Gemini), ოთხი რეჟიმი
scripts/vercel/        Vercel build (esbuild bundle, Build Output API)
scripts/localnet/      ლოკალური validator და seed
scripts/devnet/        devnet deploy
tests/e2e/             SDK ტესტები ნამდვილ localnet-ზე
deployments/*.json     მხოლოდ public მისამართები
```

Stack: Rust 1.99, Anchor 1.1.2, Solana/Agave 3.1.10, Node 24, pnpm, React 19, Vite, `@solana/web3.js`, `@solana/actions` (Blinks), wallet-adapter (Phantom), LiteSVM და Vitest, Vercel.

## Devnet

- aegis: `E6QbymjuPGqyKeQBCo2rfXiRv1Bp55uM7yVYEDnzxDhe`
- demo_dex: `BWsLwF3o7fzMmtGwp1qA2fC4sSTYt4BjzKQXCXHoEyNz`
- საიტი: https://aegis.axssell.com (write request-ები მხოლოდ ამ origin-იდან გადის)
- Blink: https://dial.to/?action=solana-action:https://aegis.axssell.com/api/actions/create&cluster=devnet

## dashboard-ის გამოყენება

1. Phantom → Settings → Developer Settings → Testnet Mode → Solana Devnet. fee-სთვის ცოტა devnet SOL დაგჭირდება (faucet.solana.com).
2. aegis.axssell.com → Connect wallet → Get 1,000 testUSDC → New demo vault (Phantom ორჯერ მოითხოვს დადასტურებას).
3. Agent console:
   - **Run normal trade** — agent ირჩევს ~20-ს, trade სრულდება
   - **Inject malicious news** — agent ემორჩილება ჩამალულ ინსტრუქციას და 1000-ს ითხოვს, პროგრამა აბრუნებს `CapExceeded`
   - **Hacker redirect** — output სხვა account-ზე იგზავნება, პროგრამა აბრუნებს `AccountMismatch`
   - Live AI / Scripted — თუ Gemini არ პასუხობს, Scripted იგივე სცენარს უშვებს
4. Revoke agent → შემდეგი trade იბლოკება `Revoked`-ით. Withdraw all → თანხა owner-ს უბრუნდება.
5. activity-ის ყველა ჩანაწერი Solana Explorer-ში იხსნება.

## ლოკალურად გაშვება (WSL)

```bash
pnpm install
anchor build
pnpm test:program      # პროგრამის ტესტები
pnpm test:sdk && pnpm test:agent && pnpm --filter web test
pnpm start:demo        # localnet + dashboard: http://127.0.0.1:5173
pnpm test:e2e          # გაშვებული start:demo-ს პარალელურად
pnpm demo              # სრული სცენარი ტერმინალში
```

Live AI-სთვის root-ში `.env`: `AI_PROVIDER=gemini`, `GEMINI_API_KEY=...`.

## Key-ები

- Vercel-ზე მხოლოდ სამი secret-ია: agent key, faucet key (testUSDC mint authority) და Gemini.
- ბრაუზერში key არ ხვდება: devnet-ზე owner Phantom-ით აწერს ხელს, localnet-ზე dev server test key-ით.

## მნიშვნელოვანი

- აუდიტი არ გაუვლია, ეს devnet-ის დემოა.
- ფასის შემოწმება ფიქსირებულ rate-ზეა; ნამდვილი slippage და oracle არ გვაქვს.
- `rotate_agent` ახალი agent-ისთვის revoke-ს მოხსნის. budget და expiry არ იცვლება.
- rate limit-ები ნაწილობრივ in-memory-ა (serverless instance-ის დონეზე), ამიტომ Vercel Firewall-იც ჩართულია.
- Blink-ში expiry ჯერჯერობით ფიქსირებულია, 1 საათი.

