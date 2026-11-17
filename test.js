'use strict';
const assert = require('assert');
const http = require('http');
const { createServer, parseMoney, normalizeProduct, collectProducts } = require('./server');

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; }
};

// ---- fixtures -------------------------------------------------------------
const product = (id, name, base, sale, extra = {}) => ({
  __typename: 'Product', id, name,
  platforms: ['PS5'],
  storeDisplayClassification: 'FULL_GAME',
  media: [{ role: 'MASTER', type: 'IMAGE', url: `https://image.api.playstation.com/vulcan/${id}.png` }],
  price: { __typename: 'SkuPrice', basePrice: base, discountedPrice: sale, discountText: null, isFree: false, isExclusive: false, isTiedToSubscription: false },
  ...extra,
});
const gridJson = (items, total) => ({ data: { categoryGridRetrieve: { __typename: 'CategoryGrid', pageInfo: { totalCount: total ?? items.length, offset: 0, size: 100, isLast: true }, products: items } } });
const items = [
  product('IN1', 'Elden Ring', '₹3,999.00', '₹1,999.50'),
  product('IN2', 'Tiny Indie', '₹499.00', '₹399.00'),
  product('IN3', 'Not On Sale', '₹1,000.00', '₹1,000.00'),
  product('IN4', 'Season Pass', '₹1,500.00', '₹750.00', { storeDisplayClassification: 'ADD_ON' }),
  product('IN5', 'Plus Price', '₹2,999.00', '₹1,499.00', { price: { basePrice: '₹2,999.00', discountedPrice: '₹1,499.00', isExclusive: true } }),
  product('IN6', 'Free One', '₹999.00', 'Free'),
];

// ---- unit tests -----------------------------------------------------------
(async () => {
  await t('parseMoney handles common Store formats', () => {
    assert.strictEqual(parseMoney('₹3,499.00'), 3499);
    assert.strictEqual(parseMoney('$59.99'), 59.99);
    assert.strictEqual(parseMoney('€59,99'), 59.99);
    assert.strictEqual(parseMoney('1.299,00 €'), 1299);
    assert.strictEqual(parseMoney('£1,299'), 1299);
    assert.strictEqual(parseMoney('CA$ 69.99'), 69.99);
    assert.strictEqual(parseMoney('Free'), 0);
    assert.strictEqual(parseMoney('Included'), null);
    assert.strictEqual(parseMoney(null), null);
  });

  await t('normalizeProduct keeps real discounts only', () => {
    const [a, b, c, d, e, f] = items.map((p, i) => normalizeProduct(p, i + 1, 'IN', 'best-sellers'));
    assert.strictEqual(a.pct, 50); assert.strictEqual(a.base, 3999); assert.strictEqual(a.sale, 1999.5);
    assert.strictEqual(a.franchise, true);
    assert.strictEqual(a.url, 'https://store.playstation.com/en-in/product/IN1');
    assert.ok(a.image.endsWith('?w=420'));
    assert.strictEqual(b.pct, 20); assert.strictEqual(b.franchise, false);
    assert.strictEqual(c, null);
    assert.strictEqual(d.kind, 'addon');
    assert.strictEqual(e.plusOnly, true);
    assert.strictEqual(f.sale, 0); assert.strictEqual(f.pct, 100);
  });

  await t('collectProducts finds products in GraphQL and Next/Apollo shaped data', () => {
    assert.strictEqual(collectProducts(gridJson(items)).length, items.length);
    const next = { props: { apolloState: { 'Product:IN1:en-in': items[0], 'Product:IN2:en-in': items[1], ROOT_QUERY: { 'x': { __ref: 'Product:IN1:en-in' } } } } };
    const found = collectProducts(next);
    assert.deepStrictEqual(found.map((p) => p.id).sort(), ['IN1', 'IN2']);
  });

  // ---- end to end with mocked fetch --------------------------------------
  const realFetch = globalThis.fetch;
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (p) => { const r = await realFetch(base + p); return { status: r.status, body: await r.json() }; };
  const ok = (body, type = 'application/json') => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fail = (status) => ({ ok: false, status, text: async () => '' });
  const nextHtml = (arr) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { apolloState: Object.fromEntries(arr.map((p) => [`Product:${p.id}`, p])) } })}</script></html>`;

  await t('GraphQL path: rotated first hash falls through to the next hash', async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('web.np.playstation.com')) {
        const hash = JSON.parse(new URL(u).searchParams.get('extensions')).persistedQuery.sha256Hash;
        seen.push(hash.slice(0, 8));
        if (hash.startsWith('9845afc0')) return ok({ errors: [{ message: 'PersistedQueryNotFound' }] });
        return ok(gridJson(items));
      }
      throw new Error('unexpected url ' + u);
    };
    const { status, body } = await api('/api/deals?region=IN');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.source, 'graphql');
    assert.strictEqual(body.rankSource, 'best-sellers');
    assert.strictEqual(body.total, 5); // all but "Not On Sale"
    assert.deepStrictEqual(seen.slice(0, 2), ['9845afc0', '4ce7d410']); // first hash rejected, next one used
  });

  await t('GraphQL path returns discounted items with ranks', async () => {
    const { body } = await api('/api/deals?region=IN');
    const titles = body.products.map((p) => p.title);
    assert.ok(titles.includes('Elden Ring'));
    assert.ok(!titles.includes('Not On Sale'));
    assert.strictEqual(body.products[0].rank, 1);
    assert.strictEqual(body.currency, 'INR');
    assert.strictEqual(body.premiumDefault, 2499);
  });

  await t('falls back to the server-rendered page when GraphQL fails', async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('web.np.playstation.com')) return fail(404);
      if (u.includes('/category/')) return u.endsWith('/1') ? ok(nextHtml(items)) : ok(nextHtml([]));
      throw new Error('unexpected url ' + u);
    };
    const { status, body } = await api('/api/deals?region=US&refresh=1');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.source, 'ssr');
    assert.strictEqual(body.rankSource, 'store-order');
    assert.ok(body.warnings.some((w) => w.startsWith('graphql')));
    assert.strictEqual(body.products[0].url.startsWith('https://store.playstation.com/en-us/'), true);
  });

  await t('reports both failures clearly when everything is blocked', async () => {
    globalThis.fetch = async () => fail(403);
    const { status, body } = await api('/api/deals?region=GB');
    assert.strictEqual(status, 502);
    assert.deepStrictEqual(body.failures.map((f) => f.step), ['graphql', 'ssr']);
    assert.ok(body.failures[0].message.includes('403'));
    assert.ok(body.hint.includes('/api/diagnose'));
  });

  await t('forced refresh is rate limited and keeps serving the cached data', async () => {
    globalThis.fetch = async (url) => (String(url).includes('web.np.playstation.com') ? ok(gridJson(items)) : fail(500));
    const first = await api('/api/deals?region=CA');
    assert.strictEqual(first.status, 200);
    globalThis.fetch = async () => fail(500);
    const again = await api('/api/deals?region=CA&refresh=1');
    // forced refresh is rate limited to once per 30s, so this is served from cache, not stale
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.total, first.body.total);
  });

  await t('rejects unknown regions and path traversal', async () => {
    assert.strictEqual((await api('/api/deals?region=ZZ')).status, 400);
    const r = await realFetch(base + '/..%2fserver.js');
    assert.ok([403, 404].includes(r.status));
  });

  await t('serves the site', async () => {
    const r = await realFetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('STORE'));
  });

  globalThis.fetch = realFetch;
  server.close();
  console.log(`\n${passed} checks passed`);
})();
