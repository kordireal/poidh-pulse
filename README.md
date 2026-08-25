# POIDH Pulse 🔋

A **live radar for open [poidh.xyz](https://poidh.xyz) bounties** across Ethereum, Base, Arbitrum and Degen.
Built as an entry for POIDH bounty [#1306](https://poidh.xyz/base/bounty/1306).

**One static file. No backend. No frameworks. No build step for readers.**

## How it works

- `index.html` embeds a **snapshot index** of all currently open bounties
  (`generatedAt`, ETH price used for USD estimates, 90+ bounties).
- Clicking any bounty **re-fetches its live state** from poidh's public,
  CORS-open endpoint `https://poidh.xyz/{chain}/bounty/{id}/data`, so amounts and
  descriptions are always fresh where freshness matters.
- A scheduled **GitHub Action** (`scripts/refresh.mjs`) re-scrapes poidh's public API
  once per day and commits an updated snapshot into this very file — the app stays
  current with zero servers and can never rot.

## Features

- USD / ETH valuation of every bounty + portfolio stats header
- Search, chain filter, sort by value / newest / deadline, hide in-progress
- Deadline countdowns, multiplayer & in-progress badges
- Live per-bounty drawer with direct claim links to poidh.xyz
- Shareable deep links (`#b/base/1306`), mobile-friendly dark UI

## Rebuild the snapshot yourself

```bash
node refresh.mjs   # writes index.html from index.template.html + live data
```

Data source: public tRPC endpoint `poidh.xyz/api/trpc/bounties.fetchAll` +
per-bounty `/data` routes. Prices: CoinGecko ETH/USD at snapshot time.
