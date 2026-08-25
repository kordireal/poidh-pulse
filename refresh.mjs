// Builds an embedded snapshot of open POIDH bounties and injects it into index.html
// Usage: node scripts/refresh.mjs
import { readFileSync, writeFileSync } from 'fs';

const CHAINS = {
  1: 'mainnet',
  8453: 'base',
  42161: 'arbitrum',
  666666666: 'degen',
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
  // sortType=value pagination via cursor (createdAt ts seen in activities cursor); fetchAll may ignore cursor -> use offset-ish strategy: also pull sortType=createdAt pages until duplicate
  const seen = new Map();
  for (const sortType of ['value', 'createdAt', 'newest']) {
    let lastTs = 0;
    for (let page = 0; page < 5; page++) {
      let items;
      try { items = await fetchPage('open', sortType); } catch { break; }
      if (!Array.isArray(items)) break;
      let newOnes = 0;
      for (const b of items) {
        if (!seen.has(b.id)) { seen.set(b.id, b); newOnes++; }
        const ts = b.createdAt ? Date.parse(b.createdAt) : 0;
        if (ts > lastTs) lastTs = ts;
      }
      if (items.length < 100 || newOnes === 0 || !lastTs) break;
    }
  }
  return [...seen.values()];
}

const [rawList, ethUsd] = await Promise.all([fetchAllOpen(), fetchEthUsd()]);

const bounties = rawList
  .filter((b) => CHAINS[b.chainId])
  .map((b) => ({
    i: b.id,
    c: CHAINS[b.chainId],
    t: (b.title || '').slice(0, 160),
    a: Number(BigInt(b.amount || 0)) / 1e18,
    ch: b.chainId,
    mp: !!b.isMultiplayer,
    ip: !!b.inProgress,
    d: b.deadline || null,
    ca: typeof b.createdAt === 'number' ? new Date(b.createdAt < 1e12 ? b.createdAt * 1000 : b.createdAt).toISOString() : (b.createdAt || null),
  }));

bounties.sort((x, y) => y.a - x.a);

const snapshot = {
  generatedAt: new Date().toISOString(),
  ethUsd,
  count: bounties.length,
  bounties,
};

const block = `<!--SNAPSHOT:START-->\nconst SNAPSHOT = ${JSON.stringify(snapshot)};\n<!--SNAPSHOT:END-->`;

let html = readFileSync(new URL('./index.template.html', import.meta.url), 'utf8');
if (!html.includes('<!--SNAPSHOT:START-->')) {
  html = html.replace('</head>', `${block}\n</head>`);
} else {
  html = html.replace(/<!--SNAPSHOT:START-->[\s\S]*?<!--SNAPSHOT:END-->/, block);
}
writeFileSync(new URL('./index.html', import.meta.url), html);

console.log(`snapshot: ${bounties.length} open bounties, ethUsd=${ethUsd}, wrote index.html`);
