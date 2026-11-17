/*
 * StoreWatch front end.
 * Data comes from this site's own server (/api/deals); the browser never calls the PlayStation Store.
 */
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 5 * 60 * 1000;
const POPULAR_TOP_RANK = 150; // top N best-sellers among current deals count as "popular"
const STORE_KEY = 'storewatch.settings.v1';

const DEFAULTS = {
  region: 'IN', sort: 'score', query: '',
  premium: null,        // null = use the region default
  maxPrice: null, minDiscount: 40,
  popularOnly: true, includeAddons: false, includePlus: false,
};

const state = { data: null, timer: null, loading: false, settings: loadSettings() };

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.settings)); } catch { /* private mode etc. */ }
}

// ---------------------------------------------------------------- helpers
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const safeStoreUrl = (u) => (/^https:\/\/store\.playstation\.com\//.test(u) ? u : '#');
const safeImageUrl = (u) => (/^https:\/\//.test(u) ? u : '');

function money(value) {
  const d = state.data;
  const whole = Math.abs(value - Math.round(value)) < 0.005;
  try {
    return new Intl.NumberFormat(d.locale, { style: 'currency', currency: d.currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(value);
  } catch { return `${d.currency} ${value.toFixed(2)}`; }
}

function premiumThreshold() {
  const s = state.settings.premium;
  return s != null && Number.isFinite(s) ? s : (state.data ? state.data.premiumDefault : 0);
}

function isPopular(p) {
  const d = state.data;
  return p.franchise || (d.rankSource === 'best-sellers' && p.rank <= POPULAR_TOP_RANK);
}

// "Best deal" score: deep discount x how premium the original price is + popularity points.
function dealScore(p) {
  const prem = premiumThreshold() || 1;
  const tier = Math.min(Math.max(p.base / prem, 0.5), 2);
  const rankPts = state.data.rankSource === 'best-sellers' ? Math.max(0, 30 * (1 - (p.rank - 1) / 300)) : 0;
  return p.pct * tier + rankPts + (p.franchise ? 10 : 0);
}

// ---------------------------------------------------------------- data
async function loadDeals(force = false) {
  if (state.loading) return;
  state.loading = true;
  $('refreshBtn').disabled = true;
  $('loading').classList.remove('hidden');
  $('errorBox').classList.add('hidden');
  $('statusText').textContent = 'Searching current regional offers…';
  const region = state.settings.region;
  try {
    const res = await fetch(`/api/deals?region=${encodeURIComponent(region)}${force ? '&refresh=1' : ''}`, { headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch { /* handled below */ }
    if (!res.ok || !body || !Array.isArray(body.products)) {
      const err = new Error((body && body.error) || `Server returned HTTP ${res.status}`);
      err.failures = (body && body.failures) || [];
      throw err;
    }
    state.data = body;
    $('liveDot').classList.remove('off');
    render();
    const t = new Date(body.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const src = body.source === 'graphql' ? 'Store best-sellers' : 'Store category page';
    $('statusText').textContent = `Updated ${t} · ${src} · next check in 5 minutes`;
    showWarnings(body);
  } catch (err) {
    showError(err);
    $('liveDot').classList.add('off');
    $('statusText').textContent = state.data ? 'Could not refresh store data (showing earlier results)' : 'Could not refresh store data';
    if (!state.data) $('resultMeta').textContent = 'No live results available';
  } finally {
    state.loading = false;
    $('refreshBtn').disabled = false;
    $('loading').classList.add('hidden');
  }
}

function showError(err) {
  const box = $('errorBox');
  const steps = (err.failures || []).map((f) => `${f.step}: ${f.message}`).join(' · ');
  box.innerHTML = `<strong>Could not load deals.</strong> ${escapeHtml(err.message)}${steps ? `<br><small>${escapeHtml(steps)}</small>` : ''}` +
    `<br><small><a href="/api/diagnose?region=${encodeURIComponent(state.settings.region)}" target="_blank" rel="noopener">Run the diagnostic</a> to see which step is failing.</small>`;
  box.classList.remove('hidden');
}

function showWarnings(data) {
  const box = $('warnBox');
  const lines = [];
  if (data.stale) lines.push('Showing the last successful update; the latest refresh failed.');
  else if (data.source === 'ssr') lines.push('Best-seller ranking is unavailable right now, so “popular” uses well-known franchises only.');
  if (!lines.length) { box.classList.add('hidden'); return; }
  box.textContent = lines.join(' ');
  box.classList.remove('hidden');
}

// ---------------------------------------------------------------- filtering + rendering
function visibleList() {
  const s = state.settings;
  const prem = premiumThreshold();
  const q = s.query.trim().toLowerCase();
  const list = state.data.products.filter((p) => {
    if (!s.includeAddons && p.kind !== 'game') return false;
    if (!s.includePlus && p.plusOnly) return false;
    if (p.base < prem) return false;
    if (p.pct < s.minDiscount) return false;
    if (s.maxPrice != null && p.sale > s.maxPrice) return false;
    if (s.popularOnly && !isPopular(p)) return false;
    if (q && !p.title.toLowerCase().includes(q)) return false;
    return true;
  });
  const scored = new Map(list.map((p) => [p.id, dealScore(p)]));
  list.sort((a, b) => {
    switch (s.sort) {
      case 'discount': return b.pct - a.pct || b.base - a.base;
      case 'savings': return (b.base - b.sale) - (a.base - a.sale);
      case 'popular': return a.rank - b.rank;
      case 'price-low': return a.sale - b.sale;
      case 'price-high': return b.base - a.base;
      case 'name': return a.title.localeCompare(b.title);
      default: return scored.get(b.id) - scored.get(a.id);
    }
  });
  return { list, scored };
}

function render() {
  const d = state.data;
  if (!d) return;
  syncControls();
  const { list, scored } = visibleList();
  $('heroCount').textContent = String(d.total);
  $('resultMeta').textContent = `${list.length} matching of ${d.total} discounted items · ${d.regionName} Store`;

  $('gamesGrid').innerHTML = list.map((p) => {
    const img = safeImageUrl(p.image);
    const cover = img
      ? `<img class="cover" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
      : '<div class="cover-fallback">🎮</div>';
    const rank = d.rankSource === 'best-sellers' && p.rank <= 300 ? `<span class="rank-badge">#${p.rank} best seller</span>` : '';
    const fran = !rank && p.franchise ? '<span class="rank-badge">Popular franchise</span>' : '';
    const plus = p.plusOnly ? '<span class="plus-badge">PS Plus price</span>' : '';
    return `<article class="game-card">
      <div class="cover-wrap">${cover}<span class="discount">-${p.pct}%</span>${rank || fran}${plus}</div>
      <div class="card-body"><h3 class="game-title">${escapeHtml(p.title)}</h3>
        <div class="price-row"><span class="sale-price">${escapeHtml(p.saleText)}</span><span class="original-price">${escapeHtml(p.baseText)}</span></div>
        <div class="price-note"><strong class="save">You save ${escapeHtml(money(p.base - p.sale))}</strong> · deal score ${Math.round(scored.get(p.id))}</div>
        <div class="card-bottom"><span class="platform">${escapeHtml(p.platforms.join(' / ') || 'PLAYSTATION')}</span><a class="store-link" href="${escapeHtml(safeStoreUrl(p.url))}" target="_blank" rel="noopener noreferrer">View in Store ↗</a></div>
      </div></article>`;
  }).join('');
  $('emptyState').classList.toggle('hidden', list.length !== 0);
}

// ---------------------------------------------------------------- controls
function syncControls() {
  const s = state.settings, d = state.data;
  $('region').value = s.region;
  $('sortSelect').value = s.sort;
  if (document.activeElement !== $('searchInput')) $('searchInput').value = s.query;
  if (d) {
    if (document.activeElement !== $('premiumInput')) $('premiumInput').value = String(premiumThreshold());
    $('curLabel1').textContent = `(${d.currency})`;
    $('curLabel2').textContent = `(${d.currency})`;
  }
  if (document.activeElement !== $('maxPriceInput')) $('maxPriceInput').value = s.maxPrice == null ? '' : String(s.maxPrice);
  $('minDiscount').value = String(s.minDiscount);
  $('popularOnly').checked = s.popularOnly;
  $('includeAddons').checked = s.includeAddons;
  $('includePlus').checked = s.includePlus;
}

function update(patch) {
  Object.assign(state.settings, patch);
  saveSettings();
  render();
}

function numberOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

$('refreshBtn').addEventListener('click', () => loadDeals(true));
$('region').addEventListener('change', (e) => {
  state.settings.region = e.target.value;
  state.settings.premium = null; // price scales differ per region, go back to that region's default
  state.settings.maxPrice = null;
  saveSettings();
  state.data = null;
  $('gamesGrid').innerHTML = '';
  loadDeals();
});
$('searchInput').addEventListener('input', (e) => update({ query: e.target.value }));
$('sortSelect').addEventListener('change', (e) => update({ sort: e.target.value }));
$('premiumInput').addEventListener('input', (e) => update({ premium: numberOrNull(e.target.value) }));
$('maxPriceInput').addEventListener('input', (e) => update({ maxPrice: numberOrNull(e.target.value) }));
$('minDiscount').addEventListener('change', (e) => update({ minDiscount: Number(e.target.value) }));
$('popularOnly').addEventListener('change', (e) => update({ popularOnly: e.target.checked }));
$('includeAddons').addEventListener('change', (e) => update({ includeAddons: e.target.checked }));
$('includePlus').addEventListener('change', (e) => update({ includePlus: e.target.checked }));
document.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
  if (btn.dataset.preset === 'hot') update({ popularOnly: true, minDiscount: 50, premium: null, maxPrice: null, includeAddons: false, includePlus: false, sort: 'score' });
  else update({ popularOnly: false, minDiscount: 1, premium: 0, maxPrice: null, sort: 'discount' });
}));

// refresh on a timer, but only while the tab is visible
function schedule() {
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) loadDeals(); }, REFRESH_MS);
}
document.addEventListener('visibilitychange', () => {
  const age = state.data ? Date.now() - new Date(state.data.fetchedAt).getTime() : Infinity;
  if (!document.hidden && age > REFRESH_MS) loadDeals();
});

syncControls();
loadDeals();
schedule();
