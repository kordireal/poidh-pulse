# POIDH Pulse — Root Cause Analysis: 1000 ETH / $2.46M Phantom Escrow

**Date:** 2026-08-26  
**Severity:** High — data-integrity defect in financial headline  
**Status:** Fixed, pending redeploy + regression

## Observation (reported via Farcaster)

Deployed UI showed as top bounty:

> **"secret menu item 27 chars plain words"** — `1000 Ξ ≈ $2.46M`
> Header: `1002.4 ETH / $2.465M escrowed`
> Project cast also advertised `≈ $2.4M escrowed`.

Expected true escrow is ~2.3 ETH / ~$5.7k. The 1000 figure dominates totals by ~500×.

## Actual On-Chain / API Truth

Pulled 2026-08-26 live:

- **Endpoint:** `GET https://poidh.xyz/degen/bounty/1382/data`
- **Raw JSON:**

```json
{
  "id": 1382,
  "onChainId": 185,
  "chainId": 666666666,
  "title": "secret menu item 27 chars plain words only by @mr94t3z",
  "amount": "1000000000000000000000",
  "issuer": "0x982cc053d6fb642505202ebdf1942169d77e4971",
  "createdAt": "1776705184",
  "inProgress": true,
  "isCanceled": false,
  "isMultiplayer": true,
  "chainId": 666666666,
  "currency": "degen",
  "priceUsd": 1.03633,
  "amountSort": 1.03633
}
```

- **Interpretation:**

  - `amount` = `1000000000000000000000` wei = `1000` token units (18 decimals)
  - `currency` = `degen`, **not** `eth`
  - `priceUsd` = `1.04` USD for the whole bounty
  - Token price implied = `1.03633 / 1000 = $0.001036/DEGEN`
  - `amountSort` (USD sort key) = `1.03633`

- **Chain proof:**

  - `chainId 666666666` = Degen chain (L3 on Base). Native gas / escrow token is **DEGEN**, not ETH.
  - `base.blockscout / eth` explorers confirm: this bounty is escrowed in DEGEN ERC-20 on Degen, not in ETH.
  - Amount in ETH terms = `0` ETH. In DEGEN terms = `1000 DEGEN ≈ $1`.

- **bounties.fetchAll (status=open, sort=value) also shows:**

```json
{
  "id": 1382,
  "amount": "1000000000000000000000",
  "amountSort": 1.03633,
  "chainId": 666666666
}
```

`amountSort` is already USD-normalized and correct. The bug ignored it.

## Why It Entered the "Open Bounty" Aggregate

`scripts/refresh.mjs` (pre-fix, lines 66-76):

```js
.map((b) => ({
  a: Number(BigInt(b.amount || 0)) / 1e18,  // <-- assumes ETH 18-decimal for ALL chains
  ch: b.chainId,
  // no currency / priceUsd / amountSort stored
}))
```

- No `currency` inspection.
- No `amountSort`/`priceUsd` cross-check.
- `b.amount / 1e18` treats DEGEN wei identically to ETH wei → `1000`.
- Header totals then did:

```js
const tot = SNAPSHOT.bounties.reduce((s,b)=>s+b.a,0)          // 1000 + 2.3 = 1002.3
const usd = tot * ethUsd                                        // 1002.3 * 2461 = $2.46M
```

- Snapshot sort `y.a - x.a` placed the phantom 1000 at rank #1, above the true top ETH bounty (0.53 ETH).

## Why the Headline Total Included It

- No outlier / impossible-value guard.
- No denomination-aware filtering.
- No validation that `a * ethUsd ≈ amountSort` (which would have flagged `2.46M vs $1`).
- The claim description for bounty #1306 was seeded from the same buggy snapshot and thus repeated `~1000 ETH escrowed` into its own bounty submission text — propagating the error into poidh's own claim store.

## Contract / Token Balance Verifiability

- On Degen chain, token is DEGEN (`0x4ed4…`). The poidh escrow contract on Degen holds `1000 DEGEN`, not `1000 ETH`. Verifiable via `eth_call` balanceOf / `eth_getBalance` on Degen RPC, but even off-chain `priceUsd` proof suffices: API says $1.
- **Thus 1000 ETH is NOT escrowed onchain. The headline was off by ~1000× in ETH and ~2400× in USD.**

## Fix Implemented

### Builder (`scripts/refresh.mjs`)

- Introduces `CHAIN_META` with explicit `currency` per `chainId`.
- Stores per bounty: `cur` (eth|degen|unknown), `u` (USD via `amountSort`/`priceUsd`), `ok` (eligible for totals), `war` (warning reason).
- Validation:
  - `amount` must be `^\d+$` + BigInt parseable; else `ok=false, war=invalid amount`.
  - Missing `chainId` → `unknown`.
  - `isCanceled` → `ok=false`.
  - `cur==='degen'` with `a>=1` → `war='non-ETH currency'`, `ok=false` (excluded from ETH totals).
  - `cur==='eth'` with `a>10` → `war='impossible ETH value'`, `ok=false`.
  - `cur==='eth'` with `ethUsd` + `u` available: compare `u` vs `a*ethUsd`; deviation >25% → outlier.
  - Amount string length / decimals sanity.
- Headline totals now:
  - `ETH escrowed` = Σ `a` where `cur==='eth' && ok`
  - `approx USD` = Σ `u` where `cur==='eth' && ok` (or `ethTot*ethUsd` fallback)
  - Outlier DEGEN row kept but **not counted**.

### Frontend (`index.template.html` → `index.html`)

- `CHAIN_CURRENCY` map, `fmtEth` vs `fmtDegen`.
- Header now shows `ETH escrowed (verified, ETH-only, excludes outliers)` + USD from eligible sum.
- Per-row rendering:
  - DEGEN rows show `1000 DEGEN ≈ $1` not `1000 Ξ`.
  - Outlier rows get `⚠️ outlier` tag + tooltip, preserved (not hidden).
  - `snapshot: N bounties • X eligible for ETH totals • eth=$Y` meta line.
- Drawer live fetch now inspects `j.currency` + `j.priceUsd`; for non-ETH it shows token amount + token USD, and flags mismatch if snapshot mis-denominated.

### Process

- `tests/regression.test.mjs` — deterministic fixture reproducing the 1000 DEGEN case; asserts post-fix totals (≈2.3 ETH, not 1002) and row warning.
- `ROOT_CAUSE.md` (this file) preserved as evidence.
- Claim #7706 follow-up: correction note to be posted (not hiding bug).

## Regression Evidence

After fix, fresh `node scripts/refresh.mjs` on 2026-08-26 20:18 data:

- `count: 92`, `ethUsd: 2469`
- `eligible ETH escrowed: 2.43… ETH` (was 1002.3)
- `eligible USD: ~ $6000` (was $2.47M)
- Top row no longer 1000; 1000-DEGEN row present at bottom with `⚠️ outlier` and `1000 DEGEN ≈ $1`.

## Lessons / Permanent Gate

This defect maps to new permanent gate requirements:

- **Gate B — Data integrity:** Any money/count/ranking display must sanity-check critical values; extreme outliers trigger verification before publication.
- **Gate D — Fresh-session reproduction:** Snapshot totals now computable independently via `amountSort` sum.

---

*Evidence retained; fix verified via on-demand `/data` fetches and local regression.*
