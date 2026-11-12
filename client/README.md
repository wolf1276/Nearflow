# NEARFlow desk

NEAR testnet perpetuals UI with native wallet transactions and finalized contract-backed APIs.

```sh
npm ci --legacy-peer-deps
cp .env.local.example .env.local
npm run dev
```

Start at `/trade/NEAR-PERP`. Configure your deployed exchange and six-decimal test token; new exposure is disabled until `/api/ready` passes. Only test funds. Each position is bilateral and isolated, either party can close the pair, and payouts are capped by counterparty margin.

See the [project README](../README.md), [architecture](../ARCHITECTURE.md), and [operations guide](../docs/OPERATIONS.md) for build, tests, deployment, oracle and keeper instructions.
