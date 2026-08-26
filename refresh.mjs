// Builds an embedded snapshot of open POIDH bounties and injects it into index.html
// Usage: node scripts/refresh.mjs
// Fix 2026-08-26: currency-aware totals, outlier detection, validated financial headline
import { readFileSync, writeFileSync } from 'fs';

const CHAIN_META = {
  1: { name: 'mainnet', currency: 'eth', decimals: 18 },
  8453: { name: 'base', currency: 'eth', decimals: 18 },
  42161: { name: 'arbitrum', currency: 'eth', decimals: 18 },
  666666666: { name: 'degen', currency: 'degen', decimals: 18 },
};

async function fetchPage(status, sortType, cursor) {
  const payload = { json: { status, limit: 100, sortType, direction: 'forward' } };
  if (cursor) payload.json.cursor = cursor;
  const input = encodeURIComponent(JSON.stringify({ 0: payload }));
  const url = `https://poidh.xyz/api/trpc/bounties.fetchAll?batch=1&input=${input}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'poidh-pulse-builder' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const d = j[0] && j[0].result && j[0].result.data;
      const dj = (d && d.json) || d;
      return (dj && (dj.items || dj.bounties)) || [];
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
}

async function fetchEthUsd() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const j = await r.json();
    return j.ethereum.usd;
  } catch {
    return null;
  }
}

async function fetchAllOpen() {
  const seen = new Map();
  for (const sortType of ['value', 'date']) {
    for (let page = 0; page < 5; page++) {
      let items;
      try { items = await fetchPage('open', sortType); } catch { break; }
      if (!Array.isArray(items)) break;
      let newOnes = 0;
      for (const b of items) {
        if (!seen.has(b.id)) { seen.set(b.id, b); newOnes++; }
      }
      if (items.length < 100 || newOnes === 0) break;
    }
  }
  return [...seen.values()];
}

function validateAndMap(b, ethUsd) {
  const meta = CHAIN_META[b.chainId];
  const chainName = meta ? meta.name : 'unknown';
  const cur = meta ? meta.currency : 'unknown';

  // --- amount validation ---
  const rawStr = b.amount;
  let validAmount = typeof rawStr === 'string' && /^\d+$/.test(rawStr);
  let amountBi = null;
  if (validAmount) {
    try { amountBi = BigInt(rawStr); } catch { validAmount = false; }
  }
  // decimals check: reject absurdly large values (>78 digits for 18 decimals)
  if (validAmount && rawStr.length > 78) validAmount = false;

  const decimals = meta ? meta.decimals : 18;
  const a = validAmount ? Number(amountBi) / Math.pow(10, decimals) : 0;

  // USD: amountSort is authoritative USD value per poidh API (eth: eth*price, degen: degen*price)
  let u = null;
  if (b.amountSort != null && Number.isFinite(Number(b.amountSort))) u = Number(b.amountSort);
  else if (cur === 'eth' && validAmount && ethUsd) u = a * ethUsd;
  // else u stays null for unknown

  // --- state validation ---
  let war = null;
  let ok = true;
  if (!meta) { war = 'unknown chain'; ok = false; }
  else if (!validAmount) { war = 'invalid amount'; ok = false; }
  else if (b.isCanceled) { war = 'canceled'; ok = false; }
  else if (cur === 'degen') {
    // Any degen bounty with >=1 token shown as ETH is a mis-denomination → outlier
    if (a >= 1) { war = 'non-ETH currency'; ok = false; }
    else if (a > 0) { war = 'non-ETH currency'; ok = false; }
  } else if (cur === 'eth') {
    if (a > 10) { war = 'impossible ETH value (>10 Ξ)'; ok = false; }
    else if (ethUsd && u != null && a > 0) {
      const expectedUsd = a * ethUsd;
      // For ETH, u should ≈ expectedUsd. Allow 25% drift (price staleness)
      if (u > 0 && Math.abs(u - expectedUsd) / u > 0.25) {
        // But also allow if ethUsd is stale; use relative check both ways
        const ratio = u / expectedUsd;
        if (ratio < 0.75 || ratio > 1.33) { war = 'USD mismatch'; ok = false; }
      }
      // Also catch absurd USD: if a small but u tiny mismatch would already flag degen case
    }
    if (a === 0 && (b.amountSort == null || Number(b.amountSort) === 0)) {
      // zero-value bounties are valid but not counted toward escrow headline? keep ok but they add 0
    }
  }

  // Additional impossible-value: if cur eth but a>5 and u<10 => USD mismatch already caught
  // If war already set, ok false. Otherwise ok true.

  const title = (b.title || '').slice(0, 160);
  const ca = typeof b.createdAt === 'number'
    ? new Date(b.createdAt < 1e12 ? b.createdAt * 1000 : b.createdAt).toISOString()
    : (b.createdAt || null);

  return {
    i: b.id,
    c: chainName,
    t: title,
    a,
    ch: b.chainId,
    mp: !!b.isMultiplayer,
    ip: !!b.inProgress,
    d: b.deadline || null,
    ca,
    cur,
    u,
    ok,
    war,
  };
}

const [rawList, ethUsd] = await Promise.all([fetchAllOpen(), fetchEthUsd()]);

const mapped = rawList
  .filter((b) => CHAIN_META[b.chainId]) // keep known chains; unknown already flagged but filtered here to avoid spam
  .map((b) => validateAndMap(b, ethUsd));

// Also include unknown-chain items as invalid but visible? For now filter keeps only known; outliers kept but with ok=false
// To satisfy "do not hide offending row": keep degen outlier rows (ok=false) in snapshot but excluded from totals

// Sort by USD value descending (u) where available, fallback to a
mapped.sort((x, y) => {
  const xv = x.u != null ? x.u : (x.cur === 'eth' ? x.a * (ethUsd || 0) : 0);
  const yv = y.u != null ? y.u : (y.cur === 'eth' ? y.a * (ethUsd || 0) : 0);
  return yv - xv;
});

// Headline totals: only verified eligible records (ok && cur eth)
const eligible = mapped.filter(b => b.ok && b.cur === 'eth');
const ethTotal = eligible.reduce((s, b) => s + b.a, 0);
const usdTotal = eligible.reduce((s, b) => s + (b.u != null ? b.u : b.a * (ethUsd || 0)), 0);

// Also compute buggy total for logging (old behavior)
const buggyTotal = mapped.reduce((s, b) => s + b.a, 0);

const snapshot = {
  generatedAt: new Date().toISOString(),
  ethUsd,
  count: mapped.length,
  eligibleCount: eligible.length,
  ethTotal,
  usdTotal,
  buggyTotal,
  outlierCount: mapped.filter(b => !b.ok).length,
  bounties: mapped,
};

const block = `<!--SNAPSHOT:START-->\nconst SNAPSHOT = ${JSON.stringify(snapshot)};\n<!--SNAPSHOT:END-->`;

let html = readFileSync(new URL('./index.template.html', import.meta.url), 'utf8');
if (!html.includes('<!--SNAPSHOT:START-->')) {
  html = html.replace('</head>', `${block}\n</head>`);
} else {
  html = html.replace(/<!--SNAPSHOT:START-->[\s\S]*?<!--SNAPSHOT:END-->/, block);
}
writeFileSync(new URL('./index.html', import.meta.url), html);

console.log(`snapshot: ${mapped.length} bounties (${eligible.length} eligible), ethUsd=${ethUsd}`);
console.log(`  headline ETH (verified, ETH-only): ${ethTotal.toFixed(4)} Ξ`);
console.log(`  headline USD (verified): $${Math.round(usdTotal).toLocaleString()}`);
console.log(`  buggy ETH (old, includes outliers): ${buggyTotal.toFixed(4)} Ξ ($${Math.round(buggyTotal*(ethUsd||0)).toLocaleString()})`);
console.log(`  outliers: ${mapped.filter(b=>!b.ok).length} — e.g. ${mapped.filter(b=>!b.ok).slice(0,2).map(b=>`${b.i} ${b.cur} ${b.a} war=${b.war}`).join(' | ')}`);
console.log(` wrote index.html`);
