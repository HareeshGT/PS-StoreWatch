/*
 * StoreWatch
 * Uses the PlayStation Store public catalogue endpoint. This is an unofficial,
 * browser-only integration; Sony may change or restrict this endpoint.
 */
const API_BASE = "https://store.playstation.com/store/api/chihiro/00_09_000";
const POPULAR_SEARCHES = [
  "Grand Theft Auto", "EA SPORTS FC", "Call of Duty", "God of War",
  "Marvel's Spider-Man", "Hogwarts Legacy", "The Last of Us",
  "Red Dead Redemption", "Ghost of Tsushima", "Elden Ring",
  "Cyberpunk 2077", "Horizon", "Final Fantasy", "Resident Evil",
  "Mortal Kombat", "Gran Turismo", "Assassin's Creed", "Stellar Blade"
];
const $ = (id) => document.getElementById(id);
const state = { games: [], timer: null, loading: false };
const region = $("region"), grid = $("gamesGrid"), loading = $("loading");
const statusText = $("statusText"), resultMeta = $("resultMeta");

function money(value, currency) {
  if (value == null || value === "") return "See Store";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  try { return new Intl.NumberFormat(undefined, { style:"currency", currency:currency || "INR", maximumFractionDigits:2 }).format(n); }
  catch { return `${currency || ""} ${n.toFixed(2)}`; }
}
function discountPercent(game) {
  const original = Number(game.price?.basePrice ?? game.price?.originalPrice ?? game.price?.regularPrice);
  const sale = Number(game.price?.discountedPrice ?? game.price?.salePrice ?? game.price?.finalPrice);
  if (original > 0 && sale >= 0 && sale < original) return Math.round((1 - sale / original) * 100);
  const explicit = Number(game.price?.discountPercentage ?? game.price?.discountPercent);
  return Number.isFinite(explicit) ? explicit : 0;
}
function getPrice(game) {
  const p = game.price || {};
  return {
    sale: p.discountedPrice ?? p.salePrice ?? p.finalPrice ?? p.basePrice,
    original: p.basePrice ?? p.originalPrice ?? p.regularPrice,
    currency: p.currencyCode || p.currency || (region.value === "IN" ? "INR" : undefined)
  };
}
function normalize(item) {
  const title = item.name || item.title || item.productName;
  if (!title) return null;
  const price = getPrice(item);
  const pct = discountPercent(item);
  const sale = Number(price.sale), original = Number(price.original);
  const isDiscounted = pct > 0 || (Number.isFinite(sale) && Number.isFinite(original) && sale < original);
  return {
    id: item.id || item.productId || title,
    title, image: item.images?.[0]?.url || item.thumbnailUrl || item.coverArtUrl || item.imageUrl || "",
    url: item.url || item.productUrl || `https://store.playstation.com/${region.value.toLowerCase()}-in/product/${item.id || ""}`,
    price, pct, isDiscounted, platform: (item.platforms || item.platform || ["PlayStation"]).
      toString().replaceAll(",", " / ")
  };
}
function productUrl(id) {
  const locale = {IN:"en-in",US:"en-us",GB:"en-gb",CA:"en-ca",AU:"en-au",DE:"de-de",FR:"fr-fr"}[region.value] || "en-in";
  return `https://store.playstation.com/${locale}/product/${encodeURIComponent(id)}`;
}
async function searchStore(term) {
  const url = new URL(`${API_BASE}/${region.value}/999/STORE-MSFXXX-SEARCH`);
  url.searchParams.set("platform", "ps4,ps5");
  url.searchParams.set("q", term);
  url.searchParams.set("size", "30");
  url.searchParams.set("start", "0");
  url.searchParams.set("bucket", "games");
  const response = await fetch(url.toString(), { headers: { "Accept":"application/json" } });
  if (!response.ok) throw new Error(`PlayStation Store returned HTTP ${response.status}`);
  const data = await response.json();
  const items = data.products || data.included || data.data || data.results || [];
  return items.map(normalize).filter(Boolean);
}
async function refreshOffers() {
  if (state.loading) return;
  state.loading = true;
  $("refreshBtn").disabled = true;
  loading.classList.remove("hidden");
  $("errorBox").classList.add("hidden");
  statusText.textContent = "Searching current regional offers…";
  try {
    // Query several popular franchises and merge duplicate product IDs.
    const batches = await Promise.allSettled(POPULAR_SEARCHES.map(searchStore));
    const successful = batches.filter(x => x.status === "fulfilled").flatMap(x => x.value);
    const failed = batches.filter(x => x.status === "rejected");
    const unique = new Map();
    successful.forEach(game => {
      const key = String(game.id);
      if (!unique.has(key)) unique.set(key, game);
    });
    state.games = [...unique.values()].filter(g => g.isDiscounted);
    if (!state.games.length && failed.length) {
      throw new Error(failed[0].reason?.message || "Could not retrieve the Store catalogue.");
    }
    state.games.forEach(g => { if (!g.url || g.url.endsWith("/")) g.url = productUrl(g.id); });
    render();
    const now = new Date();
    statusText.textContent = `Updated ${now.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})} · next check in 5 minutes`;
    resultMeta.textContent = `${state.games.length} discounted games found · ${region.options[region.selectedIndex].text} Store`;
    if (failed.length) showError(`${failed.length} of ${POPULAR_SEARCHES.length} searches could not be completed. Results may be incomplete.`);
  } catch (error) {
    showError(`${error.message}. The Store may block direct browser requests (CORS), or its catalogue API may have changed. See README for the proxy option.`);
    statusText.textContent = "Could not refresh store data";
    if (!state.games.length) resultMeta.textContent = "No live results available";
  } finally {
    state.loading = false;
    $("refreshBtn").disabled = false;
    loading.classList.add("hidden");
  }
}
function showError(message) {
  $("errorBox").textContent = message;
  $("errorBox").classList.remove("hidden");
}
function render() {
  const query = $("searchInput").value.trim().toLowerCase();
  const sort = $("sortSelect").value;
  let list = state.games.filter(g => g.title.toLowerCase().includes(query));
  list.sort((a,b) => {
    if (sort === "price-low") return Number(a.price.sale)-Number(b.price.sale);
    if (sort === "price-high") return Number(b.price.sale)-Number(a.price.sale);
    if (sort === "name") return a.title.localeCompare(b.title);
    return b.pct-a.pct;
  });
  grid.innerHTML = list.map(g => {
    const p = g.price;
    const sale = money(p.sale,p.currency), original = money(p.original,p.currency);
    const image = g.image ? `<img class="cover" src="${escapeHtml(g.image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="cover-fallback">🎮</div>`;
    return `<article class="game-card">
      <div class="cover-wrap">${image}${g.pct > 0 ? `<span class="discount">-${g.pct}%</span>` : ""}</div>
      <div class="card-body"><h3 class="game-title">${escapeHtml(g.title)}</h3>
        <div class="price-row"><span class="sale-price">${escapeHtml(sale)}</span>${p.original && String(p.original)!==String(p.sale) ? `<span class="original-price">${escapeHtml(original)}</span>` : ""}</div>
        <div class="price-note">${g.pct > 0 ? `${g.pct}% off · Regional pricing` : "Sale price shown in Store"}</div>
        <div class="card-bottom"><span class="platform">${escapeHtml(g.platform || "PLAYSTATION")}</span><a class="store-link" href="${escapeHtml(g.url)}" target="_blank" rel="noopener noreferrer">View in Store ↗</a></div>
      </div></article>`;
  }).join("");
  $("emptyState").classList.toggle("hidden", list.length !== 0);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function scheduleRefresh() {
  clearInterval(state.timer);
  state.timer = setInterval(refreshOffers, 5 * 60 * 1000);
}
$("refreshBtn").addEventListener("click", refreshOffers);
region.addEventListener("change", refreshOffers);
$("searchInput").addEventListener("input", render);
$("sortSelect").addEventListener("change", render);
refreshOffers();
scheduleRefresh();
