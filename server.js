'use strict';
/*
 * StoreWatch server
 * - Serves the static site from ./public
 * - GET /api/deals?region=IN   -> normalised list of discounted PlayStation Store items
 * - GET /api/diagnose?region=IN -> runs each data strategy once and reports what happened
 * - GET /api/health            -> cache status
 *
 * No npm dependencies. Needs Node 18+ (global fetch).
 *
 * Why a server at all: the old browser-side call went to the retired "chihiro" catalogue
 * endpoint (HTTP 404) and the Store does not send CORS headers, so a static page cannot read
 * Store data. The server calls the same unauthenticated endpoints the Store website uses.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- configuration
const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_FORCE_REFRESH_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_SIZE = 100;
const MAX_ITEMS = Number(process.env.PS_MAX_ITEMS) || 600;

const GRAPHQL_URL = 'https://web.np.playstation.com/api/graphql/v1/op';
// "All Deals" category of the PlayStation Store.
const DEALS_CATEGORY_ID = process.env.PS_DEALS_CATEGORY_ID || '3f772501-f6f8-49b7-abac-874a88ca4897';
// Persisted-query hashes for categoryGridRetrieve. Sony rotates these now and then, so several are
// tried in order. Put a fresh one first with PS_GRID_HASH (copy it from the browser network tab on
// store.playstation.com, request "categoryGridRetrieve", parameter extensions.persistedQuery.sha256Hash).
const GRID_HASHES = [
  process.env.PS_GRID_HASH,
  '9845afc0dbaab4965f6563fffc703f588c8e76792000e8610843b8d3ee9c4c09',
  '4ce7d410a4db2c8b635a48c1dcec375906ff63b19dadd87e073f8fd0c0481d35',
].filter(Boolean);

// `premium` = default "high price" threshold (original price) shown in the UI; the user can change it.
const REGIONS = {
  IN: { name: 'India', locale: 'en-IN', path: 'en-in', currency: 'INR', premium: 2499 },
  US: { name: 'United States', locale: 'en-US', path: 'en-us', currency: 'USD', premium: 39.99 },
  GB: { name: 'United Kingdom', locale: 'en-GB', path: 'en-gb', currency: 'GBP', premium: 34.99 },
  CA: { name: 'Canada', locale: 'en-CA', path: 'en-ca', currency: 'CAD', premium: 49.99 },
  AU: { name: 'Australia', locale: 'en-AU', path: 'en-au', currency: 'AUD', premium: 59.95 },
  DE: { name: 'Germany', locale: 'de-DE', path: 'de-de', currency: 'EUR', premium: 39.99 },
  FR: { name: 'France', locale: 'fr-FR', path: 'fr-fr', currency: 'EUR', premium: 39.99 },
};

// Extra "popular" signal besides the Store's own best-seller order.
const POPULAR_FRANCHISES = [
  'grand theft auto', 'ea sports fc', 'call of duty', 'god of war', 'spider-man', 'hogwarts legacy',
  'the last of us', 'red dead redemption', 'ghost of tsushima', 'elden ring', 'cyberpunk 2077',
  'horizon', 'final fantasy', 'resident evil', 'mortal kombat', 'gran turismo', "assassin's creed",
  'stellar blade', 'baldur', 'hades', 'dark souls', 'sekiro', 'persona', 'death stranding', 'fifa',
  'nba 2k', 'madden', 'minecraft', 'fortnite', 'wwe 2k', 'tekken', 'street fighter', 'monster hunter',
  'dragon ball', 'far cry', 'battlefield', 'star wars', 'ratchet', 'astro bot', 'it takes two',
];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://store.playstation.com',
  Referer: 'https://store.playstation.com/',
};

// ---------------------------------------------------------------- helpers
class StepError extends Error {
  constructor(step, message, status) {
    super(message);
    this.step = step;
    this.status = status;
  }
}

async function http_get(url, { headers = {}, accept = 'application/json' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, {
      headers: { ...BROWSER_HEADERS, Accept: accept, ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw new Error(err && err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : String(err.message || err));
  } finally {
    clearTimeout(timer);
  }
}

// "₹3,499.00" -> 3499, "$59.99" -> 59.99, "1.299,00 €" -> 1299, "Free" -> 0, "Included" -> null
function parseMoney(input) {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const s = String(input).trim();
  if (!s) return null;
  const m = s.match(/\d[\d.,\u00a0\u202f' ]*\d|\d/);
  if (!m) return /^free$/i.test(s) ? 0 : null;
  let num = m[0].replace(/[\u00a0\u202f' ]/g, '');
  const lastDot = num.lastIndexOf('.');
  const lastComma = num.lastIndexOf(',');
  let decimalSep = null;
  if (lastDot > -1 && lastComma > -1) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot > -1 || lastComma > -1) {
    const sep = lastDot > -1 ? '.' : ',';
    const count = num.split(sep).length - 1;
    const after = num.length - num.lastIndexOf(sep) - 1;
    if (count === 1 && after !== 3) decimalSep = sep; // "59.99" / "59,99" decimal; "1,299" thousands
  }
  if (decimalSep) {
    const thousands = decimalSep === '.' ? /,/g : /\./g;
    num = num.replace(thousands, '').replace(decimalSep, '.');
  } else {
    num = num.replace(/[.,]/g, '');
  }
  const v = parseFloat(num);
  return Number.isFinite(v) ? v : null;
}

function pctFromText(text) {
  const m = String(text || '').match(/(\d{1,3})\s*%/);
  return m ? Number(m[1]) : null;
}

function classify(raw) {
  const c = String(raw.storeDisplayClassification || raw.localizedStoreDisplayClassification || '').toUpperCase();
  if (!c) return 'game';
  if (/ADD[_ ]?ON|AVATAR|THEME|CONSUMABLE|CURRENCY|SEASON|PASS|DLC|EXPANSION|COSMETIC|DEMO|TRIAL|PRE[_ ]?ORDER[_ ]?BONUS/.test(c)) return 'addon';
  if (/FULL[_ ]?GAME|PREMIUM|BUNDLE|GAME|EDITION|REMASTER/.test(c)) return 'game';
  return 'other';
}

function pickImage(raw) {
  const media = Array.isArray(raw.media) ? raw.media : [];
  const imgs = media.filter((m) => m && m.url && (!m.type || /IMAGE/i.test(m.type)));
  const best =
    imgs.find((m) => /MASTER|GAMEHUB_COVER_ART|PORTRAIT/i.test(m.role || '')) ||
    imgs.find((m) => /EDITION_KEY_ART|FOUR_BY_THREE_BANNER/i.test(m.role || '')) ||
    imgs[0];
  if (!best) return '';
  const url = String(best.url);
  if (!/^https:\/\//.test(url)) return '';
  return url.includes('image.api.playstation.com') ? `${url}${url.includes('?') ? '&' : '?'}w=420` : url;
}

function isPopularFranchise(title) {
  const t = String(title).toLowerCase();
  return POPULAR_FRANCHISES.some((f) => t.includes(f));
}

// Turns one raw Store product into the compact shape the site uses; null when it is not a real discount.
function normalizeProduct(raw, rank, regionCode, rankSource) {
  if (!raw || typeof raw !== 'object') return null;
  const price = raw.price && typeof raw.price === 'object' ? raw.price : null;
  if (!price) return null;
  const base = parseMoney(price.basePrice);
  const sale = parseMoney(price.discountedPrice);
  if (base == null || sale == null || !(base > 0) || !(sale >= 0) || !(sale < base)) return null;

  const pct = Math.round((1 - sale / base) * 100) || pctFromText(price.discountText) || 0;
  if (pct <= 0) return null;

  const rp = REGIONS[regionCode];
  const typename = raw.__typename === 'Concept' ? 'concept' : 'product';
  const platforms = (Array.isArray(raw.platforms) ? raw.platforms : [])
    .map(String)
    .filter(Boolean);
  const title = String(raw.name || raw.title || '').trim();
  if (!title) return null;

  return {
    id: String(raw.id),
    title,
    kind: classify(raw),
    classification: raw.localizedStoreDisplayClassification || raw.storeDisplayClassification || '',
    image: pickImage(raw),
    url: `https://store.playstation.com/${rp.path}/${typename}/${encodeURIComponent(raw.id)}`,
    platforms,
    base,
    sale,
    pct,
    baseText: String(price.basePrice),
    saleText: String(price.discountedPrice),
    plusOnly: Boolean(price.isTiedToSubscription || price.isExclusive),
    endsAt: price.endTime ? Number(price.endTime) || null : null,
    rank, // 1 = best seller among current deals
    rankSource,
    franchise: isPopularFranchise(title),
  };
}

// Finds product-shaped objects anywhere in a JSON tree (works for GraphQL data and Apollo/Next state).
function collectProducts(root) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  let guard = 0;
  while (stack.length && guard++ < 2_000_000) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    const p = node.price;
    if (
      typeof node.id === 'string' &&
      typeof node.name === 'string' &&
      p && typeof p === 'object' &&
      (p.basePrice !== undefined || p.discountedPrice !== undefined)
    ) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        out.push(node);
      }
    }
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) stack.push(node[keys[i]]);
  }
  return out;
}

// ---------------------------------------------------------------- strategy A: web GraphQL
function gridUrl(hash, offset, size) {
  const variables = {
    id: DEALS_CATEGORY_ID,
    pageArgs: { size, offset },
    sortBy: { name: 'sales30', isAscending: false },
    filterBy: [],
    facetOptions: [],
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: hash } };
  return (
    `${GRAPHQL_URL}?operationName=categoryGridRetrieve` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`
  );
}

async function gridPage(regionCode, hash, offset, size) {
  const rp = REGIONS[regionCode];
  const res = await http_get(gridUrl(hash, offset, size), {
    headers: {
      'content-type': 'application/json',
      'x-apollo-operation-name': 'categoryGridRetrieve',
      'x-psn-store-locale-override': rp.locale,
    },
  });
  if (!res.ok) throw new StepError('graphql', `HTTP ${res.status} from the Store GraphQL endpoint`, res.status);
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new StepError('graphql', 'GraphQL endpoint returned something that is not JSON');
  }
  if (json.errors && json.errors.length) {
    const msg = json.errors.map((e) => e.message).join('; ').slice(0, 200);
    throw new StepError('graphql', `GraphQL error: ${msg}`);
  }
  const grid = json.data && json.data.categoryGridRetrieve;
  if (!grid || !Array.isArray(grid.products)) throw new StepError('graphql', 'GraphQL response had no products list');
  return grid;
}

let workingHash = null;

async function fetchViaGraphQL(regionCode, notes) {
  const hashes = workingHash ? [workingHash, ...GRID_HASHES.filter((h) => h !== workingHash)] : GRID_HASHES;
  let first = null;
  let lastErr = null;
  for (const hash of hashes) {
    try {
      first = await gridPage(regionCode, hash, 0, PAGE_SIZE);
      workingHash = hash;
      break;
    } catch (err) {
      lastErr = err;
      notes.push(`graphql hash ${hash.slice(0, 8)}…: ${err.message}`);
    }
  }
  if (!first) throw lastErr || new StepError('graphql', 'no usable persisted-query hash');

  const total = Number(first.pageInfo && first.pageInfo.totalCount) || first.products.length;
  const limit = Math.min(total, MAX_ITEMS);
  const pages = [first.products];
  const offsets = [];
  for (let o = PAGE_SIZE; o < limit; o += PAGE_SIZE) offsets.push(o);
  // small concurrency so we stay polite
  for (let i = 0; i < offsets.length; i += 3) {
    const batch = offsets.slice(i, i + 3);
    const results = await Promise.allSettled(batch.map((o) => gridPage(regionCode, workingHash, o, PAGE_SIZE)));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') pages[(batch[idx] / PAGE_SIZE) | 0] = r.value.products;
      else notes.push(`graphql page offset ${batch[idx]}: ${r.reason.message}`);
    });
  }
  const ordered = [];
  for (let i = 0; i < pages.length; i++) if (pages[i]) ordered.push(...pages[i]);
  return { raws: ordered, rankSource: 'best-sellers' };
}

// ---------------------------------------------------------------- strategy B: server-rendered category page
async function ssrPage(regionCode, page) {
  const rp = REGIONS[regionCode];
  const url = `https://store.playstation.com/${rp.path}/category/${DEALS_CATEGORY_ID}/${page}`;
  const res = await http_get(url, { accept: 'text/html,application/xhtml+xml' });
  if (!res.ok) throw new StepError('ssr', `HTTP ${res.status} from the Store category page`, res.status);
  const m = res.text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new StepError('ssr', 'category page has no __NEXT_DATA__ block (layout changed or request was blocked)');
  let json;
  try {
    json = JSON.parse(m[1]);
  } catch {
    throw new StepError('ssr', '__NEXT_DATA__ is not valid JSON');
  }
  return collectProducts(json);
}

async function fetchViaSsr(regionCode, notes) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= Math.ceil(MAX_ITEMS / 24); page++) {
    let items;
    try {
      items = await ssrPage(regionCode, page);
    } catch (err) {
      if (page === 1) throw err;
      notes.push(`ssr page ${page}: ${err.message}`);
      break;
    }
    const fresh = items.filter((p) => !seen.has(p.id));
    if (!fresh.length) break;
    fresh.forEach((p) => seen.add(p.id));
    all.push(...fresh);
  }
  if (!all.length) throw new StepError('ssr', 'category page contained no products');
  return { raws: all, rankSource: 'store-order' };
}

// ---------------------------------------------------------------- orchestration + cache
const cache = new Map(); // region -> { at, data }
const inflight = new Map();
const lastForce = new Map();

async function buildDeals(regionCode) {
  const notes = [];
  const failures = [];
  let result = null;
  let source = '';
  for (const [name, fn] of [['graphql', fetchViaGraphQL], ['ssr', fetchViaSsr]]) {
    try {
      result = await fn(regionCode, notes);
      source = name;
      break;
    } catch (err) {
      failures.push({ step: name, message: err.message, status: err.status || null });
    }
  }
  if (!result) {
    const e = new Error('Could not load deals from the PlayStation Store');
    e.failures = failures;
    e.notes = notes;
    throw e;
  }
  const products = [];
  result.raws.forEach((raw, i) => {
    const n = normalizeProduct(raw, i + 1, regionCode, result.rankSource);
    if (n) products.push(n);
  });
  const rp = REGIONS[regionCode];
  return {
    region: regionCode,
    regionName: rp.name,
    currency: rp.currency,
    locale: rp.locale,
    premiumDefault: rp.premium,
    source,
    rankSource: result.rankSource,
    fetchedAt: new Date().toISOString(),
    scanned: result.raws.length,
    total: products.length,
    warnings: [...failures.map((f) => `${f.step}: ${f.message}`), ...notes].slice(0, 8),
    products,
  };
}

async function getDeals(regionCode, force) {
  const hit = cache.get(regionCode);
  const now = Date.now();
  const fresh = hit && now - hit.at < CACHE_TTL_MS;
  const forceOk = force && now - (lastForce.get(regionCode) || 0) > MIN_FORCE_REFRESH_MS;
  if (fresh && !forceOk) return { ...hit.data, cached: true, stale: false };
  if (force) lastForce.set(regionCode, now);

  if (!inflight.has(regionCode)) {
    inflight.set(
      regionCode,
      buildDeals(regionCode)
        .then((data) => {
          cache.set(regionCode, { at: Date.now(), data });
          return data;
        })
        .finally(() => inflight.delete(regionCode)),
    );
  }
  try {
    const data = await inflight.get(regionCode);
    return { ...data, cached: false, stale: false };
  } catch (err) {
    if (hit) {
      // keep serving the last good data, but say so
      return {
        ...hit.data,
        cached: true,
        stale: true,
        warnings: [`Live refresh failed, showing data from ${hit.data.fetchedAt}`, ...(err.failures || []).map((f) => `${f.step}: ${f.message}`)],
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------- HTTP server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buf);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const region = String(url.searchParams.get('region') || 'IN').toUpperCase();
  try {
    if (url.pathname === '/api/deals') {
      if (!REGIONS[region]) return sendJson(res, 400, { error: `Unknown region "${region}"`, regions: Object.keys(REGIONS) });
      const data = await getDeals(region, url.searchParams.get('refresh') === '1');
      return sendJson(res, 200, data);
    }
    if (url.pathname === '/api/regions') {
      return sendJson(res, 200, Object.entries(REGIONS).map(([code, r]) => ({ code, name: r.name, currency: r.currency, locale: r.locale, premium: r.premium })));
    }
    if (url.pathname === '/api/diagnose') {
      if (!REGIONS[region]) return sendJson(res, 400, { error: `Unknown region "${region}"` });
      const report = { region, categoryId: DEALS_CATEGORY_ID, hashesTried: GRID_HASHES.map((h) => h.slice(0, 8)), steps: [] };
      for (const [name, fn] of [['graphql', fetchViaGraphQL], ['ssr', fetchViaSsr]]) {
        const notes = [];
        const t0 = Date.now();
        try {
          const r = await fn(region, notes);
          const normalized = r.raws.map((raw, i) => normalizeProduct(raw, i + 1, region, r.rankSource)).filter(Boolean);
          report.steps.push({ step: name, ok: true, ms: Date.now() - t0, rawItems: r.raws.length, discounted: normalized.length, sample: normalized.slice(0, 3).map((p) => `${p.title} ${p.saleText} (was ${p.baseText})`), notes });
        } catch (err) {
          report.steps.push({ step: name, ok: false, ms: Date.now() - t0, status: err.status || null, error: err.message, notes });
        }
      }
      return sendJson(res, 200, report);
    }
    if (url.pathname === '/api/health') {
      const caches = {};
      for (const [k, v] of cache) caches[k] = { ageSeconds: Math.round((Date.now() - v.at) / 1000), items: v.data.total, source: v.data.source };
      return sendJson(res, 200, { ok: true, node: process.version, caches });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown API route' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ${url.pathname} ${region}:`, err.message, err.failures || '');
    return sendJson(res, 502, {
      error: err.message || 'Unexpected error',
      failures: err.failures || [],
      hint: 'Open /api/diagnose to see exactly which step is failing.',
    });
  }
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`StoreWatch listening on http://localhost:${PORT}`));
}

module.exports = { createServer, parseMoney, normalizeProduct, collectProducts, getDeals, REGIONS, _cache: cache };
