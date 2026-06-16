import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dns from 'dns';
import { fileURLToPath } from 'url';

// Windows/Node often resolves IPv6 first and the route fails → "fetch failed"
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Start here; if busy, the server automatically tries the next ports.
const BASE_PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_TRIES = 10;
let PORT = BASE_PORT;

const FETCH_TIMEOUT_MS = 15000;
const CHART_CONCURRENCY = 16; // parallel requests for the per-symbol fallback

// Whitelists for the /chart endpoint (what Yahoo's v8 API accepts)
const VALID_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '1d']);
const VALID_RANGES    = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y']);

// News cache: avoid hammering Yahoo when flicking between stocks
const newsCache = new Map(); // symbol -> { ts, items }
const NEWS_TTL_MS = 5 * 60 * 1000;

async function getNewsItems(symbol) {
  const cached = newsCache.get(symbol);
  if (cached && Date.now() - cached.ts < NEWS_TTL_MS) return cached.items;

  const yfUrl = `https://query1.finance.yahoo.com/v1/finance/search`
    + `?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=15`;
  const yfRes = await fetch(yfUrl, {
    headers: YF_API_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!yfRes.ok) throw new Error(`Yahoo news API error: ${yfRes.status}`);

  const json = await yfRes.json().catch(() => null);
  const items = (json?.news || [])
    .map(n => ({
      title:     n.title || '',
      publisher: n.publisher || '',
      link:      n.link || '',
      time:      n.providerPublishTime || null, // unix seconds
      tickers:   Array.isArray(n.relatedTickers) ? n.relatedTickers.slice(0, 6) : [],
    }))
    .filter(n => n.title && /^https?:\/\//i.test(n.link));

  newsCache.set(symbol, { ts: Date.now(), items });
  return items;
}

// Typeahead search cache: queries repeat constantly while someone types
const searchCache = new Map(); // lowercased query -> { ts, items }
const SEARCH_TTL_MS = 10 * 60 * 1000;

// ── Live discovery: what's ACTUALLY moving right now ──────────────────────────
// Discovery is now the PRIMARY source. Yahoo's predefined screeners return full
// quote rows (price, %, volume, shares, marketCap) — we keep those rows directly
// instead of re-fetching, which also fixes shares/market-cap (screener data
// carries them reliably). Seeds are only a last-resort top-up.
const discoveryCache = {};            // marketKey -> { ts, rows }
const DISCOVERY_TTL_MS = 60 * 1000;   // 1 min — discovery now scans a universe

// The candidate universe scanned for movement when discovery runs crumbless.
// Built from the market's seed + extended lists (deduped). These are the
// liquid, day-tradeable names; the ranking surfaces whichever are moving now.
function getDiscoveryUniverse(marketKey) {
  const m = MARKETS[marketKey];
  if (!m) return [];
  // Prepend the dynamic weekly top movers (built daily from real data) so the
  // curated list always reflects what's been hot this week — for every market.
  const dynamic = getWeeklyTopSeeds(marketKey);
  return [...new Set([...dynamic, ...(m.seeds || []), ...(m.extended || [])])];
}

// ── Dynamic weekly seed list (per market) ─────────────────────────────────────
// Each day we snapshot the day's strongest movers (by |%| change and volume)
// from discovery results and store them under that market, with a date stamp.
// We keep a rolling 7-day window; the seed list is the union of those days' top
// names. This makes every market's curated list self-updating — it tracks what
// has actually been active over the trailing week instead of going stale.
const WEEKLY_FILE = path.join(os.homedir(), '.stock-scanner', 'weekly-top.json');
let _weekly = null; // { markets: { US: { 'YYYY-MM-DD': [syms] }, AU: {...}, NZ: {...} } }

function loadWeekly() {
  if (_weekly) return _weekly;
  try {
    _weekly = JSON.parse(fs.readFileSync(WEEKLY_FILE, 'utf8'));
  } catch { _weekly = {}; }
  if (!_weekly.markets) {
    // migrate the old US-only {days:{}} shape if present
    _weekly = { markets: _weekly.days ? { US: _weekly.days } : {} };
  }
  return _weekly;
}

function saveWeekly() {
  try {
    fs.mkdirSync(path.dirname(WEEKLY_FILE), { recursive: true });
    fs.writeFileSync(WEEKLY_FILE, JSON.stringify(_weekly));
  } catch { /* cache write failed — keep in memory */ }
}

function getWeeklyTopSeeds(marketKey) {
  const w = loadWeekly();
  const days = w.markets[marketKey];
  if (!days) return [];
  // prune anything older than 7 days
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  let pruned = false;
  for (const day of Object.keys(days)) {
    if (new Date(day + 'T00:00:00Z').getTime() < cutoff) {
      delete days[day]; pruned = true;
    }
  }
  if (pruned) saveWeekly();
  const set = new Set();
  for (const syms of Object.values(days)) for (const s of syms) set.add(s);
  return [...set];
}

// Record today's top movers into the rolling window for a given market.
function recordDailyTopMovers(marketKey, rows) {
  if (!rows || !rows.length) return;
  const w = loadWeekly();
  const days = w.markets[marketKey] || (w.markets[marketKey] = {});
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const top = [...rows]
    .filter(r => r.price > 0)
    .sort((a, b) => {
      const sa = Math.abs(a.change || 0) * (1 + Math.min(a.relVol || 1, 10) / 3);
      const sb = Math.abs(b.change || 0) * (1 + Math.min(b.relVol || 1, 10) / 3);
      return sb - sa;
    })
    .slice(0, 40)
    .map(r => r.ticker);
  const existing = days[today] || [];
  days[today] = [...new Set([...existing, ...top])].slice(0, 60);
  saveWeekly();
}

// ── Full US universe (every listed, non-delisted common stock / ETF) ──────────
// Pulled from NASDAQ Trader's public symbol directory (no key, no crumb).
// Cached to disk for a day — the list only changes with listings/delistings.
const UNIVERSE_FILE = path.join(os.homedir(), '.stock-scanner', 'us-universe.json');
const UNIVERSE_TTL_MS = 24 * 60 * 60 * 1000;
let _universe = null; // { ts, symbols }

async function fetchUSUniverse() {
  // memory cache
  if (_universe && Date.now() - _universe.ts < UNIVERSE_TTL_MS) return _universe.symbols;
  // disk cache
  try {
    const disk = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
    if (disk && Date.now() - disk.ts < UNIVERSE_TTL_MS && Array.isArray(disk.symbols)) {
      _universe = disk;
      return disk.symbols;
    }
  } catch { /* no/old cache — fetch fresh */ }

  const symbols = new Set();
  // nasdaqlisted.txt = NASDAQ; otherlisted.txt = NYSE / NYSE American / Arca etc.
  // We keep only NASDAQ (Exchange code Q) and NYSE (N) for a clean, liquid,
  // stock-focused universe — Arca/BATS are mostly ETF venues we don't need here.
  const sources = [
    { url: 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', isNasdaq: true },
    { url: 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt', isNasdaq: false },
  ];
  for (const { url, isNasdaq } of sources) {
    try {
      const res = await fetch(url, { headers: YF_API_HEADERS, signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const text = await res.text();
      const lines = text.split('\n');
      const header = lines[0].split('|');
      const symIdx  = header.findIndex(h => /^(Symbol|ACT Symbol|NASDAQ Symbol)$/i.test(h.trim()));
      const testIdx = header.findIndex(h => /Test Issue/i.test(h));
      const exchIdx = header.findIndex(h => /^Exchange$/i.test(h.trim())); // otherlisted only
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('|');
        if (parts.length < header.length) continue;        // footer/blank
        if (testIdx >= 0 && parts[testIdx].trim() === 'Y') continue; // test issues
        // otherlisted carries an Exchange column: N=NYSE, A=NYSE American,
        // P=NYSE Arca, Z=BATS. Keep only NYSE (N); nasdaqlisted is all NASDAQ.
        if (!isNasdaq && exchIdx >= 0 && parts[exchIdx].trim() !== 'N') continue;
        let sym = (parts[symIdx] || '').trim().toUpperCase();
        // keep plain common-stock symbols; drop warrants/units/rights/preferreds
        if (!sym || !/^[A-Z]{1,5}$/.test(sym)) continue;
        symbols.add(sym);
      }
    } catch { /* one source down — use whatever we got */ }
  }

  const arr = [...symbols];
  if (arr.length > 1000) { // sanity: only cache a plausibly-complete list
    _universe = { ts: Date.now(), symbols: arr };
    try {
      fs.mkdirSync(path.dirname(UNIVERSE_FILE), { recursive: true });
      fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(_universe));
    } catch { /* cache write failed — fine, we have it in memory */ }
    console.log(`  ◎ US universe: ${arr.length} listed symbols loaded`);
  }
  return arr;
}

// Screener rows carry shares/marketCap — cache them so seed-topup rows
// (fetched via the chart fallback, which lacks those fields) can be backfilled.
const enrichMap = new Map(); // symbol -> { shares, mktCap }
const US_SCREENERS = [
  'day_gainers', 'day_losers', 'most_actives',
  'small_cap_gainers', 'aggressive_small_caps',
  'growth_technology_stocks', 'undervalued_growth_stocks',
  'most_shorted_stocks',          // squeeze candidates
  'undervalued_large_caps',       // value with size
  'most_actives_penny_stocks',    // low-price high-volume movers
  'top_mutual_funds',             // (harmless if unsupported — skipped on error)
  'portfolio_anchors',
];

function symbolFitsMarket(sym, marketKey) {
  if (!sym || sym.length > 12 || !/^[A-Za-z0-9.\-]+$/.test(sym)) return false;
  if (/-(USD|BTC|ETH|EUR)$/i.test(sym)) return false;   // crypto pairs
  if (marketKey === 'NZ') return sym.endsWith('.NZ');
  if (marketKey === 'AU') return sym.endsWith('.AX');
  return !sym.includes('.');                            // US: plain symbols
}

// Turn a Yahoo screener/quote object into our standard row shape
function rowFromScreenerQuote(q) {
  const price = q.regularMarketPrice;
  if (typeof price !== 'number' || price <= 0) return null;
  const avgVol = q.averageDailyVolume3Month || q.averageDailyVolume10Day || 0;
  const vol    = q.regularMarketVolume || 0;
  const open   = q.regularMarketOpen ?? null;
  const prevC  = q.regularMarketPreviousClose ?? null;
  const dayHi  = q.regularMarketDayHigh ?? null;
  const dayLo  = q.regularMarketDayLow ?? null;
  const gap = (open != null && prevC > 0) ? +(((open - prevC) / prevC) * 100).toFixed(2) : null;
  const rangePos = (dayHi != null && dayLo != null && dayHi > dayLo)
    ? Math.round(((price - dayLo) / (dayHi - dayLo)) * 100) : null;
  const shares = q.sharesOutstanding
    || ((q.marketCap && price > 0) ? Math.round(q.marketCap / price) : null);
  return {
    ticker: q.symbol,
    name:   q.shortName || q.longName || q.symbol,
    price:  +price.toFixed(3),
    change: +(q.regularMarketChangePercent || 0).toFixed(2),
    gap, rangePos,
    dayHigh: dayHi, dayLow: dayLo,
    volume: vol,
    avgVol,
    relVol: avgVol > 0 ? +(vol / avgVol).toFixed(2) : null,
    shares,
    mktCap: q.marketCap || null,
    cur:    q.currency || null,
  };
}

// Returns FULL ROWS for the movers, ranked by relative volume then |change|
// Persistent per-market results so the rotating full scan accumulates coverage
const discoveryResults = {}; // key `${market}:${scope}` -> Map(ticker -> row)
let _rotationOffset = 0;

async function discoverRows(marketKey, scope = 'liquid') {
  const cacheKey = `${marketKey}:${scope}`;
  const cached = discoveryCache[cacheKey];
  if (cached && Date.now() - cached.ts < DISCOVERY_TTL_MS) return cached.rows;

  // accumulate results across rotating scans (full mode) instead of resetting
  const byTicker = discoveryResults[cacheKey] || (discoveryResults[cacheKey] = new Map());

  function ingest(quotes) {
    for (const q of quotes || []) {
      if (!symbolFitsMarket(q.symbol, marketKey)) continue;
      const row = rowFromScreenerQuote(q);
      if (row) {
        byTicker.set(row.ticker, { ...row, _seen: Date.now() });
        if (row.shares || row.mktCap) {
          enrichMap.set(row.ticker, { shares: row.shares, mktCap: row.mktCap });
        }
      }
    }
  }

  // 1) Trending (crumbless) — symbols only
  const trendingSyms = [];
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/trending/${marketKey}?count=50`,
      { headers: YF_API_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (res.ok) {
      const json = await res.json().catch(() => null);
      for (const q of json?.finance?.result?.[0]?.quotes || []) {
        if (symbolFitsMarket(q.symbol, marketKey)) trendingSyms.push(q.symbol);
      }
    }
  } catch { /* trending down — fine */ }

  // 2) Predefined screeners (need crumb) — richest source when available
  let screenerWorked = false;
  if (marketKey === 'US') {
    try {
      const { crumb, cookie } = await getYahooCrumb();
      for (const scr of US_SCREENERS) {
        const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved`
          + `?scrIds=${scr}&count=100&crumb=${encodeURIComponent(crumb)}`;
        const res = await fetch(url, {
          headers: { ...YF_API_HEADERS, Cookie: cookie || '' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) continue;   // this screener failed — try the next, don't abort all
        const json = await res.json().catch(() => null);
        ingest(json?.finance?.result?.[0]?.quotes);
        screenerWorked = true;
      }
    } catch { /* no crumb — crumbless path below still works */ }
  }

  // 3) CRUMBLESS DISCOVERY — build the candidate pool for this scope
  let pool;
  if (marketKey === 'US' && scope === 'full') {
    // Full universe, scanned in ROTATING chunks so each refresh stays fast
    // while coverage builds up across cycles into the persistent map.
    const all = await fetchUSUniverse();
    if (all.length) {
      const CHUNK = 600;
      const start = _rotationOffset % all.length;
      pool = all.slice(start, start + CHUNK);
      if (pool.length < CHUNK) pool = pool.concat(all.slice(0, CHUNK - pool.length));
      _rotationOffset = (start + CHUNK) % all.length;
    } else {
      pool = getDiscoveryUniverse(marketKey); // universe fetch failed — fall back
    }
  } else {
    // Liquid mode: the curated seed+extended universe (fast, full each time)
    pool = getDiscoveryUniverse(marketKey);
  }

  const toScan = [...new Set(pool.concat(trendingSyms))];
  if (toScan.length) {
    const rows2 = await fetchChartMany(toScan);
    for (const r of rows2) {
      byTicker.set(r.ticker, { ...r, _seen: Date.now() });
    }
    // delisted/no-data symbols this round → drop any stale row we had for them
    const got = new Set(rows2.map(r => r.ticker));
    for (const sym of toScan) {
      if (!got.has(sym) && byTicker.has(sym)) byTicker.delete(sym);
    }
  }

  // Evict rows not refreshed in a while (delisted, or rotated out long ago)
  const STALE_MS = 10 * 60 * 1000;
  for (const [sym, row] of byTicker) {
    if (row._seen && Date.now() - row._seen > STALE_MS) byTicker.delete(sym);
  }

  // rank: biggest movers + unusual volume first
  const rows = [...byTicker.values()]
    .filter(r => r.price > 0)
    .map(r => {
      const rv = r.relVol ?? 1;
      r._score = Math.abs(r.change) * (1 + Math.min(rv, 10) / 3);
      return r;
    })
    .sort((a, b) => b._score - a._score);

  discoveryCache[cacheKey] = { ts: Date.now(), rows };
  console.log(`  ◎ Discovery: ${rows.length} candidates ranked for ${marketKey}`
    + (screenerWorked ? ' (screeners + chart API)' : ' (chart API, no crumb)'));

  // Feed today's strongest names into the rolling weekly seed list (all markets)
  if (rows.length) recordDailyTopMovers(marketKey, rows);

  return rows;
}

// ── Watch score: a transparent, blended BULLISH-setup score (0–100) ───────────
// Blends day-trade momentum signals with the pattern analyzer's learned win
// rates. This is NOT a prediction — it ranks which stocks show more of the
// conditions that PRECEDE upward moves. Components are additive and capped.
function watchScore(row, learn) {
  let score = 0;
  const chg = row.change || 0;
  const rv  = row.relVol ?? 1;

  // 1) Positive momentum, but not already over-extended (fades chase badly).
  //    Sweet spot ~ +2% to +8%; taper above that.
  if (chg > 0) {
    score += chg <= 8 ? chg * 3 : (24 - (chg - 8) * 1.5);
  } else {
    score += chg * 2; // negative change drags the score down
  }

  // 2) Relative volume — conviction behind the move
  score += Math.min(rv, 6) * 5; // up to +30

  // 3) Range position — buying into strength near the day's highs
  if (row.rangePos != null) {
    if (row.rangePos >= 60) score += (row.rangePos - 60) / 4; // up to +10 near highs
    else if (row.rangePos <= 20) score -= 5;                  // weak, near lows
  }

  // 4) Gap up that's holding (gap + still green)
  if (row.gap != null && row.gap > 1 && chg > 0) score += Math.min(row.gap, 10);

  // 5) Learned pattern edge — bonus if recent bullish patterns on this name's
  //    timeframe have historically won (uses the self-learning file)
  if (learn?.patterns) {
    const bullish = ['Hammer', 'Bullish engulfing', 'Three white soldiers'];
    let best = 0;
    for (const p of bullish) {
      const s = learn.patterns[p];
      const n = s ? s.w + s.l : 0;
      if (n >= 5) best = Math.max(best, s.w / n);
    }
    if (best > 0.5) score += (best - 0.5) * 30; // up to +15 for a strong learned edge
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Yahoo Finance headers ──────────────────────────────────────────────────────
// Full browser-like header set — a bare Accept:application/json triggers
// Yahoo's bot detection and gets 406 Not Acceptable on the crumb endpoint.
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};
// JSON API calls use a lighter variant that still passes bot checks
const YF_API_HEADERS = {
  'User-Agent': YF_HEADERS['User-Agent'],
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

// ── Crumb handling (only needed for the v7 batch endpoint) ────────────────────
let _crumb = null;
let _cookie = null;
let _crumbPromise = null;
let _v7Broken = false; // once v7 keeps failing, skip straight to the chart API

function resetCrumb() {
  _crumb = null;
  _cookie = null;
  _crumbPromise = null;
}

async function getYahooCrumb() {
  if (_crumb) return { crumb: _crumb, cookie: _cookie };
  if (_crumbPromise) return _crumbPromise;

  _crumbPromise = (async () => {
    // Step 1: get the session cookie from the finance homepage using full
    // browser headers (fc.yahoo.com is effectively dead now)
    let cookies = [];
    for (const url of ['https://finance.yahoo.com/', 'https://finance.yahoo.com/quote/AAPL']) {
      try {
        const r = await fetch(url, {
          headers: YF_HEADERS,
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const got = r.headers.getSetCookie?.() || [];
        if (got.length) { cookies = got; break; }
      } catch { /* try next */ }
    }
    _cookie = cookies.map(c => c.split(';')[0]).join('; ');

    // Step 2: get crumb — try both hosts, using JSON API headers + the cookie
    let crumb = null;
    for (const host of ['query1', 'query2']) {
      try {
        const r = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
          headers: { ...YF_API_HEADERS, Cookie: _cookie || '' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (r.ok) {
          const text = (await r.text()).trim();
          if (text && !text.includes('<') && text.length <= 64) { crumb = text; break; }
        }
      } catch { /* try next host */ }
    }

    if (!crumb) throw new Error('Crumb unavailable (Yahoo rejected the handshake)');

    _crumb = crumb;
    console.log('  ✓ Yahoo crumb acquired');
    return { crumb: _crumb, cookie: _cookie };
  })();

  try {
    return await _crumbPromise;
  } catch (err) {
    resetCrumb();
    throw err;
  }
}

// ── Primary: v7 batch quote (50 symbols per call, needs crumb) ────────────────
async function fetchBatchV7(symbols, isRetry = false) {
  const { crumb, cookie } = await getYahooCrumb();
  const host = isRetry ? 'query2' : 'query1'; // second attempt uses the other host
  const url = `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(crumb)}`;

  const res = await fetch(url, {
    headers: { ...YF_API_HEADERS, Cookie: cookie || '' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (res.status === 429) {
    resetCrumb();
    throw new Error('Rate limited by Yahoo Finance (429)');
  }

  if (res.status === 401 || res.status === 403) {
    resetCrumb();
    if (!isRetry) return fetchBatchV7(symbols, true);
    throw new Error(`v7 endpoint rejected the request (${res.status})`);
  }

  if (!res.ok) throw new Error(`v7 endpoint error: ${res.status} ${res.statusText}`);

  const json = await res.json().catch(() => null);
  return json?.quoteResponse?.result || [];
}

function rowFromV7(q) {
  if (typeof q.regularMarketPrice !== 'number') return null;
  const avgVol = q.averageDailyVolume3Month || q.averageDailyVolume10Day || 0;
  const vol = q.regularMarketVolume || 0;
  const price = q.regularMarketPrice;
  const open  = q.regularMarketOpen ?? null;
  const prevC = q.regularMarketPreviousClose ?? null;
  const dayHi = q.regularMarketDayHigh ?? null;
  const dayLo = q.regularMarketDayLow ?? null;

  // Gap %: where today OPENED relative to yesterday's close (the day-trade gap)
  const gap = (open != null && prevC > 0) ? +(((open - prevC) / prevC) * 100).toFixed(2) : null;
  // Range position: where price sits inside today's high-low range (0–100%)
  const rangePos = (dayHi != null && dayLo != null && dayHi > dayLo)
    ? Math.round(((price - dayLo) / (dayHi - dayLo)) * 100) : null;

  // Supply: shares outstanding (estimate from mkt cap if the field is missing)
  const shares = q.sharesOutstanding
    || ((q.marketCap && price > 0) ? Math.round(q.marketCap / price) : null);

  return {
    ticker: q.symbol,
    name:   q.shortName || q.longName || q.symbol,
    price:  +price.toFixed(3),
    change: +(q.regularMarketChangePercent || 0).toFixed(2),
    gap,
    rangePos,
    dayHigh: dayHi, dayLow: dayLo,
    volume: vol,
    avgVol,
    relVol: avgVol > 0 ? +(vol / avgVol).toFixed(2) : null,
    shares,
    mktCap: q.marketCap || null,
    cur:    q.currency || null,
  };
}

// ── Fallback: v8 chart endpoint (one symbol per call, NO crumb/cookie) ────────
// This endpoint has stayed reliable while v7 increasingly returns 401s.
// 3 months of daily bars gives us: current price, % change, volume and avg vol.
// ── Market regime ────────────────────────────────────────────────────────────
// Reads the S&P 500's recent daily path and classifies the environment as
// trending or choppy. Two complementary measures, both 0..1:
//   • R²  — how cleanly closes fit a straight line (high = directional)
//   • efficiency ratio — net move ÷ total path length (high = little zig-zag)
// Trending markets favour breakouts/continuation; choppy markets favour fading
// the edges (mean-reversion). The regime tells you WHICH signals to trust.
let _regimeCache = null;
async function computeMarketRegime() {
  if (_regimeCache && Date.now() - _regimeCache.ts < 10 * 60 * 1000) return _regimeCache.val;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1mo&interval=1d`;
  const res = await fetch(url, { headers: YF_API_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const closes = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [])
    .filter(c => typeof c === 'number');
  if (closes.length < 12) return null;
  const win = closes.slice(-20);
  const n = win.length;

  // R² of close vs bar index
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  win.forEach((c, i) => { sx += i; sy += c; sxy += i * c; sxx += i * i; });
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const icept = (sy - slope * sx) / n;
  const mean = sy / n;
  let ssRes = 0, ssTot = 0;
  win.forEach((c, i) => { const fit = icept + slope * i; ssRes += (c - fit) ** 2; ssTot += (c - mean) ** 2; });
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // efficiency ratio: |net change| ÷ sum of |bar-to-bar changes|
  let net = Math.abs(win[n - 1] - win[0]), path = 0;
  for (let i = 1; i < n; i++) path += Math.abs(win[i] - win[i - 1]);
  const eff = path > 0 ? net / path : 0;

  // combine: both high → trending; both low → choppy
  const trendScore = (r2 * 0.6 + eff * 0.4);
  const dir = slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat';
  let regime, advice;
  if (trendScore >= 0.55) {
    regime = `trending ${dir}`;
    advice = dir === 'up'
      ? 'Breakouts and pullback-buys tend to work; fading strength is risky.'
      : 'Breakdowns and bounce-sells tend to work; buying dips is risky.';
  } else if (trendScore <= 0.3) {
    regime = 'choppy / range-bound';
    advice = 'Fading the edges (buy support, sell resistance) tends to work; breakouts often fail.';
  } else {
    regime = 'mixed / transitioning';
    advice = 'No clear edge for trend or reversion right now — trade smaller or wait.';
  }
  const val = { regime, dir, advice, trendScore: +trendScore.toFixed(2), r2: +r2.toFixed(2), eff: +eff.toFixed(2) };
  _regimeCache = { ts: Date.now(), val };
  return val;
}

async function fetchChartOne(symbol) {  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const res = await fetch(url, {
    headers: YF_API_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta || {};
  const price = meta.regularMarketPrice;
  if (typeof price !== 'number') return null;

  const quote  = result.indicators?.quote?.[0] || {};
  const vols   = (quote.volume || []).filter(v => typeof v === 'number' && v > 0);
  const closes = (quote.close  || []).filter(c => typeof c === 'number');

  // Previous close: prefer the explicit field; otherwise second-to-last bar.
  // (meta.chartPreviousClose is the close before the whole 3-month window —
  //  NOT yesterday — so it must not be used here.)
  let prevClose = meta.regularMarketPreviousClose;
  if (typeof prevClose !== 'number' && closes.length >= 2) {
    prevClose = closes[closes.length - 2];
  }

  const change = (typeof prevClose === 'number' && prevClose > 0)
    ? ((price - prevClose) / prevClose) * 100
    : 0;

  const vol    = meta.regularMarketVolume || (vols.length ? vols[vols.length - 1] : 0);
  const avgVol = vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : 0;

  // Today's open = the open of the most recent daily bar
  const opens  = (quote.open || []).filter(o => typeof o === 'number');
  const open   = opens.length ? opens[opens.length - 1] : null;
  const dayHi  = meta.regularMarketDayHigh ?? null;
  const dayLo  = meta.regularMarketDayLow ?? null;

  const gap = (open != null && typeof prevClose === 'number' && prevClose > 0)
    ? +(((open - prevClose) / prevClose) * 100).toFixed(2) : null;
  const rangePos = (dayHi != null && dayLo != null && dayHi > dayLo)
    ? Math.round(((price - dayLo) / (dayHi - dayLo)) * 100) : null;

  return {
    ticker: meta.symbol || symbol,
    name:   meta.longName || meta.shortName || symbol,
    price:  +price.toFixed(3),
    change: +change.toFixed(2),
    gap,
    rangePos,
    dayHigh: dayHi, dayLow: dayLo,
    volume: vol,
    avgVol,
    relVol: avgVol > 0 ? +(vol / avgVol).toFixed(2) : null,
    shares: null, // not exposed by the chart endpoint
    mktCap: null, // chart endpoint doesn't expose market cap
    cur:    meta.currency || null,
  };
}

// Run the per-symbol fallback with limited concurrency
async function fetchChartMany(symbols) {
  const results = [];
  let idx = 0;
  let failures = 0;

  async function worker() {
    while (idx < symbols.length) {
      const sym = symbols[idx++];
      try {
        const row = await fetchChartOne(sym);
        if (row) results.push(row);
        else failures++;
      } catch {
        failures++;
      }
    }
  }

  await Promise.all(Array.from({ length: CHART_CONCURRENCY }, worker));
  if (failures) console.log(`  (chart fallback: ${failures} symbols returned no data — likely delisted)`);
  return results;
}

// ── Main quote fetcher: try v7 batches first, fall back to v8 charts ──────────
async function fetchQuotes(tickers) {
  const results = [];
  const failedSymbols = [];
  const chunkSize = 50;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  if (!_v7Broken) {
    for (let i = 0; i < tickers.length; i += chunkSize) {
      const chunk = tickers.slice(i, i + chunkSize);
      try {
        const quotes = await fetchBatchV7(chunk);
        for (const q of quotes) {
          const row = rowFromV7(q);
          if (row) results.push(row);
        }
      } catch (err) {
        console.warn(`  [v7 batch ${i}–${i + chunk.length}] ${err.message}`);
        failedSymbols.push(...chunk);
      }
      if (i + chunkSize < tickers.length) await delay(300);
    }

    // If every single batch failed, stop wasting time on v7 for this session
    if (results.length === 0 && failedSymbols.length === tickers.length) {
      _v7Broken = true;
      console.log('  ⚠ v7 quote endpoint is not working — switching to chart API fallback');
    }
  } else {
    failedSymbols.push(...tickers);
  }

  // Fallback for anything v7 couldn't deliver (capped to keep scans fast)
  if (failedSymbols.length > 0) {
    const list = failedSymbols.slice(0, 250);
    if (failedSymbols.length > list.length) {
      console.log(`  (fallback capped at ${list.length} of ${failedSymbols.length} symbols)`);
    }
    console.log(`  → Fetching ${list.length} symbols via chart API (no crumb needed)…`);
    const fallbackRows = await fetchChartMany(list);
    results.push(...fallbackRows);
  }

  // Backfill shares/mktCap from screener-harvested data wherever it's missing
  for (const r of results) {
    if (r.shares == null || r.mktCap == null) {
      const e = enrichMap.get(r.ticker);
      if (e) {
        if (r.shares == null && e.shares) r.shares = e.shares;
        if (r.mktCap == null && e.mktCap) r.mktCap = e.mktCap;
        // estimate the one we still lack from the one we have
        if (r.shares == null && r.mktCap && r.price > 0) r.shares = Math.round(r.mktCap / r.price);
        if (r.mktCap == null && r.shares && r.price > 0) r.mktCap = Math.round(r.shares * r.price);
      }
    }
  }

  return results;
}

// ── Market definitions ─────────────────────────────────────────────────────────
const MARKETS = {
  US: {
    label: 'US (NASDAQ / NYSE)',
    suffix: '',
    currency: '$',
    minPrice: 2,
    maxPrice: 20,
    seeds: [
      "BBAI","SOUN","HIMS","JOBY","ACHR","LUNR","ASTS","RKLB","SPCE",
      "NKLA","WKHS","BLNK","CHPT","EVGO","FCEL","PLUG","BLDP","HYLN",
      "FSR","FFIE","MULN","IDEX","GFAI","IMVT","APLT","PRAX","ARQT",
      "VERV","BEAM","EDIT","NTLA","CRSP","BLUE","SAGE","AGEN","CLOV",
      "SOFI","UWMC","SPIR","BTBT","CIFR","MARA","RIOT","HUT","BITF",
      "CLSK","IREN","IONQ","QUBT","RGTI","QBTS","NVAX","OCGN","SAVA",
      "ADMA","ATOS","ABEV","VALE","ITUB","BBD","GOLD","AUY","KGC","EGO",
      "AG","PAAS","CDE","HL","EXK","TELL","SD","NOG","BORR","NE",
      "ZI","LMND","ROOT","KPLT","XPEV","NIO","LI","GPRO","VZIO","SONO",
      "HEAR","KOSS","KODK","EXPR","MFA","MITT","NYMT","ORC","CIM","AGNC",
      "ARR","DX","IVR","PMT","TWO","NLY","RC","SOS","GNUS","CTRM",
      "SHIP","TOPS","FREE","GOGL","SBLK","EGLE","GBOX","GREE","NAKD"
    ],
    // Extra tickers used when "Extended" list mode is on
    extended: [
      "AMC","GME","BB","NOK","PLTR","HOOD","DKNG","LCID","RIVN","PSNY",
      "GRAB","OPEN","RKT","AFRM","UPST","LC","OPRT","OSCR","TDOC","PTON",
      "AAL","JBLU","UAL","NCLH","CCL","SNCY","MESA","SAVE",
      "HBAN","KEY","RF","FLG","BANC",
      "F","T","WBD","PARA","SIRI","LUMN","M","KSS","FIGS","BARK",
      "BTU","RIG","KOS","VET","CRK","REI","AMPY","WTI",
      "UEC","UUUU","DNN","NXE","URG","LEU","SMR","OKLO","NNE",
      "RUN","MAXN","SHLS","ARRY","CSIQ","JKS","NOVA",
      "AMRN","ACAD","IOVA","ALLO","FATE","SANA","RXRX","PACB","EXAI",
      "ABCL","DNA","CRBU","TLRY","CGC","ACB","SNDL","CRON","GRWG",
      "AI","PATH","BIGC","FSLY","VLD","DNMR","STEM","AMPS","LAZR",
      "OUST","INVZ","MVIS","WOLF","NVTS","INDI","AEVA","AEYE",
      "RDW","PL","BKSY","SATL","GSAT","KULR","RCAT","SERV","RR",
      "WULF","CORZ","APLD","BTDR","HIVE","CAN","BKKT","GLXY","ZIM"
    ],
  },
  AU: {
    label: 'Australia (ASX)',
    suffix: '.AX',
    currency: 'A$',
    minPrice: 0.10,
    maxPrice: 5,
    seeds: [
      "AVZ.AX","LIT.AX","PLS.AX","MIN.AX","IGO.AX","AKE.AX","SYA.AX","LKE.AX","GL1.AX","WC8.AX",
      "FFX.AX","NVX.AX","WBT.AX","BOE.AX","PDN.AX","DYL.AX","BMN.AX","SFR.AX","NST.AX","EVN.AX",
      "RRL.AX","WAF.AX","ALK.AX","DCN.AX","BGL.AX","SBM.AX","RSG.AX","CMM.AX","MLX.AX","PRU.AX",
      "BRN.AX","VHT.AX","IMU.AX","TLX.AX","RMD.AX","PME.AX","NEU.AX","PNV.AX","MSB.AX","CUV.AX",
      "ZIP.AX","EML.AX","FMG.AX","NHC.AX","WHC.AX","YAL.AX","MRC.AX","MGX.AX","CIA.AX","GRR.AX",
    ],
    extended: [
      "CXO.AX","LTR.AX","VUL.AX","INR.AX","AGY.AX","LPI.AX","GLN.AX","PMT.AX","SYR.AX","TLG.AX",
      "LOT.AX","AGE.AX","PEN.AX","EL8.AX","BKY.AX",
      "GOR.AX","GMD.AX","PNR.AX","KCN.AX","AMI.AX","RMS.AX","WGX.AX","TIE.AX","OBM.AX","CHN.AX","SPR.AX",
      "BPT.AX","KAR.AX","CVN.AX","STX.AX","COE.AX","88E.AX",
      "LYC.AX","ARU.AX","HAS.AX","ILU.AX","VML.AX",
      "DUB.AX","4DX.AX","ALC.AX","EOS.AX","DRO.AX","WZR.AX","SLX.AX","TYR.AX","APX.AX","BUB.AX",
      "PYC.AX","OPT.AX","IMM.AX","PAR.AX","BOT.AX"
    ],
  },
  NZ: {
    label: 'New Zealand (NZX)',
    suffix: '.NZ',
    currency: 'NZ$',
    minPrice: 0.10,
    maxPrice: 5,
    seeds: [
      "AIR.NZ","ATM.NZ","SKC.NZ","FPH.NZ","MFT.NZ","EBO.NZ","IFT.NZ",
      "MEL.NZ","CEN.NZ","MCY.NZ","KPG.NZ","PCT.NZ","ARG.NZ",
      "PFI.NZ","SPK.NZ","SKT.NZ","TWR.NZ","THL.NZ","NZM.NZ",
      "SCL.NZ","HGH.NZ","RBD.NZ","BRM.NZ","CVT.NZ","DGL.NZ",
      "FSF.NZ","GNE.NZ","HLG.NZ","KFL.NZ",
      "OCA.NZ","PLX.NZ","RYM.NZ","SAN.NZ",
      "SCT.NZ","SML.NZ","STU.NZ","TIL.NZ",
      "VHP.NZ","WIN.NZ","XRO.NZ","AIA.NZ"
    ],
    extended: [
      "ARV.NZ","BGP.NZ","CDI.NZ","CNU.NZ","ERD.NZ","FBU.NZ","FWL.NZ","GMT.NZ",
      "GTK.NZ","GXH.NZ","IPL.NZ","KMD.NZ","MHJ.NZ","NZK.NZ","NZX.NZ","PEB.NZ",
      "PGW.NZ","POT.NZ","PYS.NZ","RAK.NZ","SKL.NZ","SPG.NZ","SUM.NZ","TRA.NZ",
      "VCT.NZ","VGL.NZ","WHS.NZ","MOV.NZ","BLT.NZ","AOF.NZ"
    ],
  },
  // User-built list of stocks from any other exchange (LSE, TSX, HKEX, …).
  // The frontend supplies the tickers (kept in the browser's localStorage).
  OTHER: {
    label: 'Other Markets',
    suffix: '',
    currency: '',
    minPrice: 0,
    maxPrice: 999999,
    seeds: [],
  },
};

// ── Ticker cache ──────────────────────────────────────────────────────────────
const tickerCache = {};

function getTickersForMarket(marketKey, mode = 'standard') {
  const cacheKey = `${marketKey}:${mode}`;
  if (!tickerCache[cacheKey]) {
    const market = MARKETS[marketKey];
    let tickers = market.seeds;
    if (mode === 'extended') {
      // merge + dedupe
      tickers = [...new Set([...market.seeds, ...(market.extended || [])])];
    }
    tickerCache[cacheKey] = tickers;
    console.log(`  ${market.label}: ${tickers.length} tickers loaded (${mode})`);
  }
  return tickerCache[cacheKey];
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
// ── Self-learning storage ──────────────────────────────────────────────────────
// Pattern/forecast feedback lives in the user's home dir so it survives both
// app updates and reinstalls (the install dir is replaced on every update).
const LEARN_DIR  = path.join(os.homedir(), '.stock-scanner');
const LEARN_FILE = path.join(LEARN_DIR, 'learning.json');
const JOURNAL_FILE = path.join(LEARN_DIR, 'journal.json');
const PAPER_FILE = path.join(LEARN_DIR, 'paper.json');
const CANDLE_DIR = path.join(LEARN_DIR, 'candles');

// ── Candle-history storage ────────────────────────────────────────────────
// Each symbol/interval gets a JSON file of accumulated bars. We merge new bars
// in by timestamp (dedup, keep latest values), cap the file so it can't grow
// without bound, and only store intraday timeframes (daily already has years).
const CANDLE_CAP = { '1m': 4000, '2m': 4000, '5m': 6000, '15m': 6000, '30m': 5000, '60m': 5000, '1d': 0 };

function candleFile(symbol, interval) {
  const safe = symbol.replace(/[^A-Za-z0-9.\-^=]/g, '_');
  return path.join(CANDLE_DIR, `${safe}__${interval}.json`);
}

function readCandleHistory(symbol, interval) {
  try {
    return JSON.parse(fs.readFileSync(candleFile(symbol, interval), 'utf8')) || [];
  } catch { return []; }
}

function readCandleHistoryCount(symbol, interval) {
  return readCandleHistory(symbol, interval).length;
}

function mergeCandleHistory(symbol, interval, fresh) {
  const cap = CANDLE_CAP[interval];
  if (!cap || !fresh || !fresh.length) return; // daily/unknown → skip storage
  try {
    fs.mkdirSync(CANDLE_DIR, { recursive: true });
    const existing = readCandleHistory(symbol, interval);
    const byTime = new Map();
    for (const c of existing) byTime.set(c.time, c);
    for (const c of fresh) byTime.set(c.time, c);     // fresh overwrites stale
    let merged = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (merged.length > cap) merged = merged.slice(-cap); // keep most recent
    // recompute gapBefore across the stitched series (boundaries shift on merge)
    const secs = { '1m':60,'2m':120,'5m':300,'15m':900,'30m':1800,'60m':3600 }[interval] || 60;
    for (let i = 0; i < merged.length; i++) {
      merged[i].gapBefore = i > 0 && (merged[i].time - merged[i - 1].time) > secs * 2.5;
    }
    const tmp = candleFile(symbol, interval) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, candleFile(symbol, interval));   // atomic
  } catch { /* storage failure is non-fatal — live data still works */ }
}

// Synchronous read of the learning file for watchScore (small file, cached)
let _learnCache = null, _learnCacheTs = 0;
function readLearnSync() {
  if (_learnCache && Date.now() - _learnCacheTs < 30000) return _learnCache;
  try {
    _learnCache = JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8'));
  } catch { _learnCache = { patterns: {}, trend: {} }; }
  _learnCacheTs = Date.now();
  return _learnCache;
}

function readBody(req, limit = 300000) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('Body too large')); return; }
      body += c;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let _htmlCache = null;
let _htmlMtime = 0;
function getIndexHtml() {
  const file = path.join(__dirname, 'index.html');
  const stat = fs.statSync(file);
  if (!_htmlCache || stat.mtimeMs !== _htmlMtime) {
    _htmlCache = fs.readFileSync(file);
    _htmlMtime = stat.mtimeMs;
  }
  return _htmlCache;
}

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const route = urlObj.pathname;

  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getIndexHtml());
      return;
    }

    if (route === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && route === '/markets') {
      const info = Object.fromEntries(
        Object.entries(MARKETS).map(([k, v]) => [k, {
          label: v.label, currency: v.currency,
          minPrice: v.minPrice, maxPrice: v.maxPrice,
        }])
      );
      // WATCH is a virtual tab: bullish setups from the US universe
      info.WATCH = { label: 'Watch (bullish setups)', currency: '$', minPrice: 0, maxPrice: 999999 };
      sendJSON(res, 200, info);
      return;
    }

    // Index tracking: S&P 500 (^GSPC) and Dow Jones (^DJI) for the header ticker
    if (req.method === 'GET' && route === '/indices') {
      const out = {};
      await Promise.all([
        { key: 'sp500', sym: '^GSPC', label: 'S&P 500' },
        { key: 'dow', sym: '^DJI', label: 'Dow Jones' },
        { key: 'nasdaq', sym: '^IXIC', label: 'Nasdaq' },
      ].map(async ({ key, sym, label }) => {
        try {
          const row = await fetchChartOne(sym);
          if (row) out[key] = { label, price: row.price, change: row.change };
        } catch { /* index unavailable this tick */ }
      }));
      // Market regime, read from the S&P's recent daily path
      let regime = null;
      try { regime = await computeMarketRegime(); } catch { /* non-fatal */ }
      sendJSON(res, 200, { ok: true, indices: out, regime, ts: Date.now() });
      return;
    }

    if (req.method === 'GET' && route === '/scan') {
      const marketKey = (urlObj.searchParams.get('market') || 'US').toUpperCase();
      const scope = urlObj.searchParams.get('scope') === 'full' ? 'full' : 'liquid';

      if (marketKey !== 'WATCH' && !MARKETS[marketKey]) {
        sendJSON(res, 400, { ok: false, error: 'Unknown market: ' + marketKey });
        return;
      }

      const TARGET = 200; // how many stocks we aim to show

      if (marketKey === 'OTHER') {
        // OTHER has no discovery — the client sends its saved tickers
        const tickers = (urlObj.searchParams.get('tickers') || '')
          .split(',')
          .map(s => s.trim())
          .filter(s => s && s.length <= 12 && /^[A-Za-z0-9.\-^=]+$/.test(s))
          .slice(0, 100);
        const data = tickers.length ? await fetchQuotes(tickers) : [];
        sendJSON(res, 200, {
          ok: true, data, scanned: tickers.length, discovered: 0, seeded: 0,
          market: marketKey, currency: '', ts: Date.now(),
        });
        return;
      }

      // ── WATCH tab: bullish-setup candidates from the US universe ──
      if (marketKey === 'WATCH') {
        const learn = readLearnSync();
        const pool = await discoverRows('US', scope);
        const scored = pool
          .map(r => ({ ...r, watch: watchScore(r, learn) }))
          .filter(r => r.watch >= 35 && r.change > -2) // bullish setups only
          .sort((a, b) => b.watch - a.watch)
          .slice(0, 60);
        console.log(`[${new Date().toLocaleTimeString()}] WATCH: ${scored.length} bullish setups (from ${pool.length} candidates)`);
        sendJSON(res, 200, {
          ok: true, data: scored, scanned: scored.length, discovered: pool.length,
          market: 'WATCH', currency: '$', ts: Date.now(),
        });
        return;
      }

      // ── Discovery: scans the universe + screeners, ranks by movement ──
      const discovered = await discoverRows(marketKey, scope);
      const data = discovered.slice(0, TARGET);

      console.log(`[${new Date().toLocaleTimeString()}] ${marketKey} (${scope}): ${discovered.length} candidates → showing top ${data.length}`);

      sendJSON(res, 200, {
        ok: true,
        data,
        scanned: data.length,
        discovered: discovered.length,
        scope,
        seeded: 0,
        market: marketKey,
        currency: MARKETS[marketKey].currency,
        ts: Date.now(),
      });
      return;
    }

    // ── Single-symbol quote row (used to pin a searched stock) ──────────────
    if (req.method === 'GET' && route === '/quote') {
      const symbol = (urlObj.searchParams.get('symbol') || '').trim();
      if (!symbol || symbol.length > 12 || !/^[A-Za-z0-9.\-^=]+$/.test(symbol)) {
        sendJSON(res, 400, { ok: false, error: 'Invalid symbol' });
        return;
      }
      const row = await fetchChartOne(symbol).catch(() => null);
      if (!row) {
        sendJSON(res, 502, { ok: false, error: 'No quote data available for ' + symbol });
        return;
      }
      sendJSON(res, 200, { ok: true, row });
      return;
    }

    // ── Candlestick data for one symbol (uses the crumbless v8 chart API) ──
    if (req.method === 'GET' && route === '/chart') {
      const symbol   = (urlObj.searchParams.get('symbol') || '').trim();
      const interval = urlObj.searchParams.get('interval') || '1m';
      const range    = urlObj.searchParams.get('range') || '1d';

      if (!symbol || symbol.length > 12 || !/^[A-Za-z0-9.\-^=]+$/.test(symbol)) {
        sendJSON(res, 400, { ok: false, error: 'Invalid symbol' });
        return;
      }
      if (!VALID_INTERVALS.has(interval) || !VALID_RANGES.has(range)) {
        sendJSON(res, 400, { ok: false, error: 'Invalid interval or range' });
        return;
      }

      const prepost = urlObj.searchParams.get('prepost') === '1';
      const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
        + `?range=${range}&interval=${interval}&includePrePost=${prepost ? 'true' : 'false'}`;

      const yfRes = await fetch(yfUrl, {
        headers: YF_API_HEADERS,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!yfRes.ok) {
        sendJSON(res, 502, { ok: false, error: `Yahoo chart API error: ${yfRes.status}` });
        return;
      }

      const json   = await yfRes.json().catch(() => null);
      const result = json?.chart?.result?.[0];
      if (!result) {
        sendJSON(res, 502, { ok: false, error: json?.chart?.error?.description || 'No chart data returned' });
        return;
      }

      const meta  = result.meta || {};
      const ts    = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const { open = [], high = [], low = [], close = [], volume = [] } = quote;

      const candles = [];
      let lastT = -Infinity;
      // expected seconds between bars for this interval — a gap much larger than
      // this means a session boundary (overnight/weekend) was crossed.
      const intervalSecs = {
        '1m': 60, '2m': 120, '5m': 300, '15m': 900,
        '30m': 1800, '60m': 3600, '1d': 86400,
      }[interval] || 60;
      // collect volumes to derive a thin-print floor (median-based)
      const volSamples = [];
      for (let i = 0; i < ts.length; i++) {
        if ([open[i], high[i], low[i], close[i]].some(v => typeof v !== 'number')) continue;
        if (typeof ts[i] !== 'number' || ts[i] <= lastT) continue;
        // a "session boundary" gap = time jump > 2.5× the normal bar spacing
        // (intraday) — for daily bars, > ~2.5 days catches weekends/holidays.
        const gapBefore = lastT !== -Infinity && (ts[i] - lastT) > intervalSecs * 2.5;
        lastT = ts[i];
        const v = volume[i] || 0;
        if (v > 0) volSamples.push(v);
        candles.push({
          time:   ts[i], // unix seconds
          open:   +open[i].toFixed(4),
          high:   +high[i].toFixed(4),
          low:    +low[i].toFixed(4),
          close:  +close[i].toFixed(4),
          volume: v,
          gapBefore,            // true if a session boundary precedes this bar
        });
      }
      // mark thin prints: bars whose volume is far below the session's typical
      // (under 15% of median). These are overnight/illiquid quotes that swing on
      // tiny size — excluded from learning, still drawn on the chart.
      if (volSamples.length > 4) {
        const sorted = [...volSamples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const thinFloor = median * 0.15;
        for (const c of candles) c.thin = c.volume > 0 && c.volume < thinFloor;
      } else {
        for (const c of candles) c.thin = false;
      }

      // ── Persist candle history so backtests grow beyond Yahoo's short window ──
      // Merge these freshly-fetched bars into a per-symbol/interval file on disk.
      // Over weeks of use this accumulates far more history than a single fetch.
      mergeCandleHistory(symbol, interval, candles);

      // If the client asks for the full accumulated history, return that instead
      // of just the live window (used by the backtester for a longer sample).
      let outCandles = candles;
      if (urlObj.searchParams.get('hist') === '1') {
        const stored = readCandleHistory(symbol, interval);
        if (stored.length > candles.length) outCandles = stored;
      }

      sendJSON(res, 200, {
        ok: true,
        symbol: meta.symbol || symbol,
        name:   meta.longName || meta.shortName || symbol,
        price:  meta.regularMarketPrice ?? null,
        prevClose: meta.regularMarketPreviousClose ?? null,
        cur:    meta.currency || null,
        interval,
        range,
        candles: outCandles,
        stored: readCandleHistoryCount(symbol, interval),
      });
      return;
    }

    // ── News headlines for one symbol (crumbless Yahoo search API) ──────────
    if (req.method === 'GET' && route === '/news') {
      const symbol = (urlObj.searchParams.get('symbol') || '').trim();
      if (!symbol || symbol.length > 12 || !/^[A-Za-z0-9.\-^=]+$/.test(symbol)) {
        sendJSON(res, 400, { ok: false, error: 'Invalid symbol' });
        return;
      }
      try {
        const items = await getNewsItems(symbol);
        sendJSON(res, 200, { ok: true, symbol, items });
      } catch (e) {
        sendJSON(res, 502, { ok: false, error: e.message });
      }
      return;
    }

    // ── News pulse: latest-headline freshness for many symbols at once ──────
    // Powers the breaking-news flame. Cached per symbol, limited concurrency.
    if (req.method === 'GET' && route === '/news-pulse') {
      const symbols = (urlObj.searchParams.get('symbols') || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => s && s.length <= 12 && /^[A-Za-z0-9.\-^=]+$/.test(s))
        .slice(0, 50);

      const pulse = {};
      let idx = 0;
      async function worker() {
        while (idx < symbols.length) {
          const sym = symbols[idx++];
          try {
            const items = await getNewsItems(sym);
            const latest = items.reduce((best, n) =>
              (n.time && (!best || n.time > best.time)) ? n : best, null);
            if (latest && latest.time) {
              pulse[sym] = { t: latest.time, title: latest.title, publisher: latest.publisher };
            }
          } catch { /* symbol without news data — skip */ }
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker));
      sendJSON(res, 200, { ok: true, pulse });
      return;
    }

    // ── Symbol/company typeahead search (crumbless Yahoo search API) ────────
    if (req.method === 'GET' && route === '/search') {
      const q = (urlObj.searchParams.get('q') || '').trim().slice(0, 40);
      if (!q) {
        sendJSON(res, 200, { ok: true, q, items: [] });
        return;
      }

      const key = q.toLowerCase();
      const cached = searchCache.get(key);
      if (cached && Date.now() - cached.ts < SEARCH_TTL_MS) {
        sendJSON(res, 200, { ok: true, q, items: cached.items, cached: true });
        return;
      }

      const yfUrl = `https://query1.finance.yahoo.com/v1/finance/search`
        + `?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=true`;

      const yfRes = await fetch(yfUrl, {
        headers: YF_API_HEADERS,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!yfRes.ok) {
        sendJSON(res, 502, { ok: false, error: `Yahoo search API error: ${yfRes.status}` });
        return;
      }

      const json = await yfRes.json().catch(() => null);
      const items = (json?.quotes || [])
        .filter(it => it.symbol && (it.quoteType === 'EQUITY' || it.quoteType === 'ETF'))
        .map(it => ({
          symbol: it.symbol,
          name:   it.shortname || it.longname || it.symbol,
          exch:   it.exchDisp || it.exchange || '',
          type:   it.quoteType,
        }))
        .slice(0, 8);

      // simple cap so the cache can't grow forever
      if (searchCache.size > 300) searchCache.clear();
      searchCache.set(key, { ts: Date.now(), items });

      sendJSON(res, 200, { ok: true, q, items });
      return;
    }

    // ── Self-learning persistence ────────────────────────────────────────────
    if (route === '/learning' && req.method === 'GET') {
      try {
        const raw = await fs.promises.readFile(LEARN_FILE, 'utf8');
        sendJSON(res, 200, { ok: true, data: JSON.parse(raw) });
      } catch {
        sendJSON(res, 200, { ok: true, data: null }); // first run — nothing learned yet
      }
      return;
    }

    if (route === '/learning' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          sendJSON(res, 400, { ok: false, error: 'Learning data must be an object' });
          return;
        }
        await fs.promises.mkdir(LEARN_DIR, { recursive: true });
        const tmp = LEARN_FILE + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(data));
        await fs.promises.rename(tmp, LEARN_FILE); // atomic — a crash can't corrupt it
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    if (route === '/paper' && req.method === 'GET') {
      try {
        const raw = await fs.promises.readFile(PAPER_FILE, 'utf8');
        sendJSON(res, 200, { ok: true, data: JSON.parse(raw) });
      } catch {
        sendJSON(res, 200, { ok: true, data: null }); // first run — client seeds defaults
      }
      return;
    }

    if (route === '/paper' && req.method === 'POST') {
      try {
        const body = await readBody(req, 2_000_000);
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          sendJSON(res, 400, { ok: false, error: 'Paper account must be an object' });
          return;
        }
        await fs.promises.mkdir(LEARN_DIR, { recursive: true });
        const tmp = PAPER_FILE + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(data));
        await fs.promises.rename(tmp, PAPER_FILE);
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    if (route === '/journal' && req.method === 'GET') {
      try {
        const raw = await fs.promises.readFile(JOURNAL_FILE, 'utf8');
        sendJSON(res, 200, { ok: true, data: JSON.parse(raw) });
      } catch {
        sendJSON(res, 200, { ok: true, data: { trades: [] } }); // first run
      }
      return;
    }

    if (route === '/journal' && req.method === 'POST') {
      try {
        const body = await readBody(req, 2_000_000); // journals can grow — allow 2MB
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          sendJSON(res, 400, { ok: false, error: 'Journal must be an object' });
          return;
        }
        await fs.promises.mkdir(LEARN_DIR, { recursive: true });
        const tmp = JOURNAL_FILE + '.tmp';
        await fs.promises.writeFile(tmp, JSON.stringify(data));
        await fs.promises.rename(tmp, JOURNAL_FILE);
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    if (req.method === 'GET' && route === '/refresh-tickers') {
      const marketKey = (urlObj.searchParams.get('market') || 'US').toUpperCase();
      delete tickerCache[`${marketKey}:standard`];
      delete tickerCache[`${marketKey}:extended`];
      resetCrumb();
      _v7Broken = false; // give v7 another chance after a manual refresh
      sendJSON(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('Request error:', err.message);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: err.message });
  }
});

// ── Startup network self-test ──────────────────────────────────────────────────
// Tells you in plain language whether the machine can reach Yahoo at all,
// so "no stocks" can be diagnosed from the terminal output alone.
async function networkSelfTest() {
  console.log('  Running network self-test…');
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d',
      { headers: YF_API_HEADERS, signal: AbortSignal.timeout(10000) }
    );
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      console.log(`  ✓ Yahoo reachable — AAPL test quote: $${price ?? '?'}\n`);
      return true;
    }
    console.warn(`  ⚠ Yahoo responded with HTTP ${res.status}. Quotes may be blocked from your IP.\n`);
    return false;
  } catch (e) {
    console.error('  ❌ Cannot reach Yahoo Finance at all:', e.cause?.code || e.message);
    console.error('     This is a network problem on this machine, not a code problem.');
    console.error('     Check: VPN, proxy, firewall, antivirus "web protection", or DNS.');
    console.error('     Test in PowerShell with:');
    console.error('       curl.exe "https://query1.finance.yahoo.com/v8/finance/chart/AAPL"\n');
    return false;
  }
}

// ── Startup: exported so Electron (main.js) can launch the server, ────────────
//    while `node server.js` still works standalone.
export function startServer() {
  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const next = PORT + 1;
        if (next < BASE_PORT + MAX_PORT_TRIES) {
          console.warn(`  \u26a0 Port ${PORT} is in use \u2014 trying ${next}\u2026`);
          PORT = next;
          server.listen(next);
          return;
        }
        reject(new Error(
          `Ports ${BASE_PORT}\u2013${PORT} are all in use.\n`
          + `Find the culprit with:  netstat -ano | findstr :${BASE_PORT}\n`
          + `If netstat shows nothing, Windows has reserved the range \u2014 check:\n`
          + `netsh interface ipv4 show excludedportrange protocol=tcp`
        ));
        return;
      }
      reject(err);
    });

    server.on('listening', async () => {
      console.log('\n  \u2705  Stock Scanner is running!');
      console.log(`  \ud83d\udc49  http://localhost:${PORT}\n`);

      resolve(PORT); // hand the final port back immediately \u2014 don't block on Yahoo

      await networkSelfTest();
      try {
        await getYahooCrumb();
      } catch (e) {
        console.warn('  \u26a0 Could not pre-fetch Yahoo crumb:', e.message);
        console.warn('    No problem \u2014 scans will use the chart API fallback.\n');
      }
    });

    server.listen(PORT);
  });
}

export function stopServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1000);
  });
}

// Running directly under plain Node (node server.js)
if (!process.versions.electron) {
  startServer().catch((err) => {
    console.error('\n  \u274c ' + err.message + '\n');
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n  Shutting down\u2026');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}