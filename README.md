# Flipt single-wallet runner

A small Arc Testnet TypeScript runner for testing a single wallet workflow. It records every simulated action and persists counters locally.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Put the private key for a dedicated **testnet-only** wallet in `.env`, then run:

```powershell
npm run start
```

The runner defaults to `DRY_RUN=true`: it checks the wallet and simulates cycles without submitting transactions. It writes JSONL activity logs and a cumulative counter file beneath `data/`.

## Contract integration

`createLaunch`, `buyOnCurve`, and `managePosition` deliberately throw if `DRY_RUN=false`. Replace their guarded sections only with verified factory/router addresses, ABIs, and function parameters obtained from a confirmed Arc Testnet transaction. Do not disable dry-run mode beforehand.

> Update: the Arc Testnet flow is now implemented. With `DRY_RUN=false`, the runner derives a CREATE2 vanity salt, preflights each launch/buy, checks USDC allowance, and waits for receipts. `CREATE_ICON_URI` must be an existing Flipt-hosted image. Description, banner, and links are frontend metadata; `MIN_TOKENS_OUT=0` is the permissive testnet default.

Useful optional `.env` settings:

- `MAX_CYCLES=5` exits after five cycles (`0` keeps running).
- `FAST_MODE=true` shortens delays for test runs.
- `MIN_BALANCE_USDC=3` controls the low-balance threshold.
- `MAX_BUY_USDC=10` limits generated buy sizes.

Stop cleanly with `Ctrl+C`; counters are saved after each action.
