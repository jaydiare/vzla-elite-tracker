// js/app.js

const athleteDataRaw = [
  { name: "Ronald Acuña Jr.", sport: "Baseball", league: "MLB", team: "Braves" },
  { name: "Jackson Chourio", sport: "Baseball", league: "MLB", team: "Brewers" },
  { name: "Maikel Garcia", sport: "Baseball", league: "MLB", team: "Royals" },
  { name: "Salvador Perez", sport: "Baseball", league: "MLB", team: "Royals" },
  { name: "Eugenio Suárez", sport: "Baseball", league: "MLB", team: "Diamondbacks" },
  { name: "Jose Altuve", sport: "Baseball", league: "MLB", team: "Astros" },
  { name: "Luis Arráez", sport: "Baseball", league: "MLB", team: "Padres" },
  { name: "William Contreras", sport: "Baseball", league: "MLB", team: "Brewers" },
  { name: "Anthony Santander", sport: "Baseball", league: "MLB", team: "Orioles" },
  { name: "Wilyer Abreu", sport: "Baseball", league: "MLB", team: "Red Sox" },
  { name: "Eduardo Rodriguez", sport: "Baseball", league: "MLB", team: "Diamondbacks" },
  { name: "Francisco Alvarez", sport: "Baseball", league: "MLB", team: "Mets" },

  { name: "Yeferson Soteldo", sport: "Soccer", league: "Serie A", team: "Grêmio" },
  { name: "Jon Aramburu", sport: "Soccer", league: "La Liga", team: "Real Sociedad" },
  { name: "Josef Martínez", sport: "Soccer", league: "MLS", team: "CF Montréal" },
  { name: "Salomón Rondón", sport: "Soccer", league: "Liga MX", team: "Pachuca" },
  { name: "Darwin Machís", sport: "Soccer", league: "La Liga", team: "Cádiz" },
  { name: "Jefferson Savarino", sport: "Soccer", league: "Serie A", team: "Botafogo" },
  { name: "Yangel Herrera", sport: "Soccer", league: "La Liga", team: "Girona" },

  { name: "Michael Carrera", sport: "Basketball", league: "LNBP", team: "Astros de Jalisco" },

  { name: "Daniel Dhers", sport: "BMX", league: "BMX", team: "BMX" },
  { name: "Yulimar Rojas", sport: "Track & Field", league: "Track & Field", team: "Track & Field" },
  { name: "Jhonattan Vegas", sport: "Golf", league: "PGA", team: "Golf" },
  { name: "Garbiñe Muguruza", sport: "Tennis", league: "WTA", team: "Venezuela" },
  { name: "Marlon Vera", sport: "MMA", league: "UFC", team: "Venezuela" },
  { name: "Andres Borregales", sport: "Football", league: "NFL", team: "New England Patriots" },
  { name: "Amleto Monacelli", sport: "Bowling", league: "Bowling", team: "PBA50" }
];

let athleteData = [];
let ebayAvgRaw = {};
let activeSport = "All"; // sport buttons row

// Dropdown filters (optional; only used if the elements exist in HTML)
let activeCategory = "all";
let activeLeague = "all";
let activePrice = "all";
let activeStability = "all"; // ✅ NEW

// Price threshold used by the Price dropdown (Low/High). Adjust as you like.
const PRICE_LOW_MAX = 20;

// ---------- Helpers ----------
function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function makeNameSportKey(name, sport) {
  return `${norm(name)}|${norm(sport)}`;
}

function mergeByNameSportKeepBest(localArr, fetchedArr) {
  const map = new Map();

  const score = (o) =>
    ["league", "team", "tier", "sport"].reduce((n, f) => n + (o?.[f] ? 1 : 0), 0);

  const add = (a) => {
    const key = makeNameSportKey(a?.name, a?.sport);
    if (!key || key === "|") return;

    const prev = map.get(key);
    if (!prev) map.set(key, a);
    else map.set(key, score(a) >= score(prev) ? a : prev);
  };

  (localArr || []).forEach(add);
  (fetchedArr || []).forEach(add);

  return Array.from(map.values());
}

async function fetchJsonWithFallback(path) {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Initials avatar (no photos)
function initialsFromName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "VZ";
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? (parts[1]?.[0] || "") : (parts[0]?.[1] || "");
  return (a + b).toUpperCase();
}

// Debounce (for smoother input feel)
function debounce(fn, delay = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// OS hint for the ⌘K bubble (so Windows shows Ctrl K)
function isMacPlatform() {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent);
}

function setKbdHint() {
  const el = document.getElementById("search-kbd"); // optional
  if (!el) return;

  el.innerHTML = isMacPlatform()
    ? `<span class="kbd">⌘</span><span class="kbd">K</span>`
    : `<span class="kbd">Ctrl</span><span class="kbd">K</span>`;
}

// Fill dropdown filter options (only if selects exist)
function fillFilterOptions() {
  const catSel = document.getElementById("filter-category");
  const leagueSel = document.getElementById("filter-league");
  const stabilitySel = document.getElementById("filter-stability"); // ✅ NEW

  if (catSel && leagueSel) {
    const sports = Array.from(new Set((athleteData || []).map((a) => a?.sport).filter(Boolean))).sort();

    catSel.innerHTML =
      `<option value="all">All</option>` +
      sports.map((s) => `<option value="${s}">${s}</option>`).join("") +
      `<option value="Other">Other</option>`;

    const leagues = Array.from(new Set((athleteData || []).map((a) => a?.league).filter(Boolean))).sort();

    leagueSel.innerHTML =
      `<option value="all">All</option>` +
      leagues.map((l) => `<option value="${l}">${l}</option>`).join("");
  }

  // ✅ NEW: Stability filter options (only if the select exists)
  if (stabilitySel) {
    stabilitySel.innerHTML =
      `<option value="all">All</option>` +
      `<option value="stable">Stable (0–10%)</option>` +
      `<option value="active">Active (10–20%)</option>` +
      `<option value="volatile">Volatile (20–35%)</option>` +
      `<option value="highly_unstable">Highly Unstable (35%+)</option>` +
      `<option value="none">No Score</option>`;
  }
}

// ---------- "Last updated" label (from ebay-avg.json _meta.updatedAt) ----------
function timeAgo(isoString) {
  const then = new Date(isoString);
  if (Number.isNaN(then.getTime())) return "—";

  const now = new Date();
  let seconds = Math.floor((now - then) / 1000);
  if (seconds < 0) seconds = 0;

  const mins = Math.floor(seconds / 60);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);

  if (seconds < 60) return `${seconds}s ago`;
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  return `${days}d ago`;
}

function updateEbayLastUpdatedLabelFrom(ebayJson) {
  const el = document.getElementById("ebay-last-updated");
  if (!el) return;

  const updatedAt = ebayJson?._meta?.updatedAt;
  el.textContent = updatedAt ? `Last updated: ${timeAgo(updatedAt)}` : "Last updated: —";
}

// ---------- eBay Avg Index ----------
const ebayAvgByName = {};
const ebayAvgByKey = {};

function buildEbayIndexes(obj) {
  Object.keys(ebayAvgByName).forEach((k) => delete ebayAvgByName[k]);
  Object.keys(ebayAvgByKey).forEach((k) => delete ebayAvgByKey[k]);

  if (!obj || typeof obj !== "object") return;

  for (const k of Object.keys(obj)) {
    if (k === "_meta") continue;

    const rec = obj[k];
    if (!rec) continue;

    ebayAvgByName[k] = rec;

    // Only build key index if sport exists
    if (rec?.sport) {
      ebayAvgByKey[makeNameSportKey(k, rec.sport)] = rec;
    }
  }
}

function getEbayAvgFor(athlete) {
  if (!athlete) return null;
  const key = makeNameSportKey(athlete.name, athlete.sport);
  return ebayAvgByKey[key] || ebayAvgByName[athlete.name] || null;
}

// Canonical numeric price (works for avgListing / taguchiListing / legacy avg)
function getEbayAvgNumber(athlete) {
  const avg = getEbayAvgFor(athlete);

  const avgNum =
    avg?.avgListing ??
    avg?.taguchiListing ??
    avg?.trimmedListing ??
    avg?.avg ??
    avg?.average ??
    null;

  if (avgNum == null) return null;

  const v = Number(avgNum);
  if (!Number.isFinite(v) || v <= 0) return null;

  return v;
}

// Market stability CV -> label
function getMarketStabilityCV(athlete) {
  const rec = getEbayAvgFor(athlete);

  // ✅ Support both shapes:
  // - top-level: rec.marketStabilityCV
  // - marketplace: rec.marketplaces.EBAY_US.marketStabilityCV, etc.
  const v =
    rec?.marketStabilityCV ??
    rec?.marketplaces?.EBAY_US?.marketStabilityCV ??
    rec?.marketplaces?.EBAY_CA?.marketStabilityCV ??
    null;

  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null; // ratio (0.12 = 12%)
}

function getAvgDaysOnMarket(athlete) {
  const rec = getEbayAvgFor(athlete);

  const v =
    rec?.avgDaysOnMarket ??
    rec?.marketplaces?.EBAY_US?.avgDaysOnMarket ??
    rec?.marketplaces?.EBAY_CA?.avgDaysOnMarket ??
    null;

  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ✅ UPDATED tiers to include Highly Unstable (35%+)
function marketStabilityScoreFromCV(cv) {
  if (cv == null) return { label: "—", pctText: "—", bucket: "none" };

  const pct = cv * 100;
  const pctText = `${pct.toFixed(0)}%`;

  if (pct < 10) return { label: "Stable", pctText, bucket: "stable" };
  if (pct < 20) return { label: "Active", pctText, bucket: "active" };
  if (pct < 35) return { label: "Volatile", pctText, bucket: "volatile" };
  return { label: "Highly Unstable", pctText, bucket: "highly_unstable" };
}

function getStabilityBucketForAthlete(athlete) {
  const cv = getMarketStabilityCV(athlete);
  return marketStabilityScoreFromCV(cv).bucket;
}

function formatCurrency(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";

  const c = String(currency || "").toUpperCase();
  if (c === "CAD") return `C$${n.toFixed(2)}`;
  if (c === "USD") return `$${n.toFixed(2)}`;
  return `${c} ${n.toFixed(2)}`;
}

function buildEbaySearchUrl(name, sport) {
  const base = "https://www.ebay.ca/sch/i.html";
  const query = encodeURIComponent(`${name} ${sport} trading card`);

  return (
    `${base}?_nkw=${query}` +
    `&_sacat=261328` + // Trading Card Singles
    `&LH_BIN=1` + // Buy It Now only
    `&LH_PrefLoc=1`
  );
}

// ---------- UI (Sport buttons row) ----------
function setSport(sport, btn) {
  activeSport = sport;

  const filterBar = document.getElementById("sport-filters");
  if (filterBar) {
    filterBar.querySelectorAll("button").forEach((b) => {
      b.classList.remove("text-[#f2f20d]");
      b.classList.add("text-slate-500");
    });
  }

  if (btn) {
    btn.classList.remove("text-slate-500");
    btn.classList.add("text-[#f2f20d]");
  } else {
    const buttons = filterBar?.querySelectorAll("button");
    buttons?.forEach((x) => {
      const t = x.textContent.trim().toLowerCase();
      const s = String(sport || "").trim().toLowerCase();
      if (t === s) {
        x.classList.remove("text-slate-500");
        x.classList.add("text-[#f2f20d]");
      }
    });
  }

  renderGrid(athleteData);
}
window.setSport = setSport;

// CardHedge-like card (no photos)
function renderAthleteCard(a) {
  const avgNum = getEbayAvgNumber(a);

  // display currency to USD (your ebay script normalizes to USD)
  const money = avgNum != null ? `USD ${formatCurrency(avgNum, "USD")}` : "—";

  const cv = getMarketStabilityCV(a);
  const stability = marketStabilityScoreFromCV(cv);

  const dom = getAvgDaysOnMarket(a);
  const domText = dom != null ? `${Math.round(dom)} days` : "—";

  const shopUrl = buildEbaySearchUrl(a.name, a.sport);
  const initials = initialsFromName(a.name);

  return `
    <article class="athlete-card">
      <div class="athlete-card__top">
        <div class="athlete-card__avatar">${initials}</div>

        <div class="athlete-card__head">
          <div class="athlete-card__name">${a.name}</div>
          <div class="athlete-card__pill">${a.sport}</div>
        </div>
      </div>

      <div class="athlete-card__value">${money}</div>
      <div class="athlete-card__label">eBay Avg. listing Price</div>

    <div class="vzla-search-count">
      Market Stability :
      <span class="athlete-card__stability-pill">${stability.label}</span>
      <span class="athlete-card__stability-pct">(${stability.pctText})</span>
    </div>
    
    <div class="vzla-search-count">
      Avg. time listed:
      <span class="athlete-card__days-val">${domText}</span>
    </div>

      <div class="vzla-search-count">*prices may vary*</div>

      <a href="${shopUrl}" target="_blank" class="athlete-card__cta">
        Shop Collectibles
      </a>

      <div class="athlete-card__meta">
        ${a.league} • ${a.team}
      </div>
    </article>
  `;
}

function renderGrid(list) {
  const grid = document.getElementById("athletes-grid");
  if (!grid) return;

  const input = document.getElementById("search-input");
  const q = norm(input?.value || "");

  const catSel = document.getElementById("filter-category");
  const leagueSel = document.getElementById("filter-league");
  const priceSel = document.getElementById("filter-price");
  const stabilitySel = document.getElementById("filter-stability");

  const category = catSel?.value ?? activeCategory;
  const league = leagueSel?.value ?? activeLeague;
  const price = priceSel?.value ?? activePrice; // "all" | "low" | "high" | "none"
  const stability = stabilitySel?.value ?? activeStability; // "all" | buckets... | "none"

  let filtered = (list || [])
    // 1) Sport buttons row
    .filter((a) => {
      if (activeSport === "All") return true;
      if (activeSport === "Other") {
        return !["Baseball", "Soccer", "Basketball"].includes(a.sport);
      }
      return a.sport === activeSport;
    })
    // 2) Category dropdown
    .filter((a) => {
      if (!catSel) return true;
      if (category === "all") return true;
      if (category === "Other") return !["Baseball", "Soccer", "Basketball"].includes(a.sport);
      return a.sport === category;
    })
    // 3) League dropdown
    .filter((a) => {
      if (!leagueSel) return true;
      if (league === "all") return true;
      return a.league === league;
    })
    // ✅ 4) Stability dropdown (FIXED so “Stable” doesn’t include “No Score” or “No Price”)
    .filter((a) => {
      if (!stabilitySel) return true;
      if (stability === "all") return true;

      const cv = getMarketStabilityCV(a);
      const bucket = marketStabilityScoreFromCV(cv).bucket;

      // explicitly show "No Score" only when requested
      if (stability === "none") return cv == null || bucket === "none";

      // if user selected a real bucket, require BOTH:
      // - a valid CV score
      // - a valid price estimate (prevents weird cards slipping in)
      if (cv == null) return false;
      if (getEbayAvgNumber(a) == null) return false;

      return bucket === stability;
    })
    // 5) Search query
    .filter((a) => !q || norm(a.name).includes(q));

  // 6) Price dropdown behavior (sorting + none filter)
  if (priceSel) {
    if (price === "none") {
      filtered = filtered.filter((a) => getEbayAvgNumber(a) == null);
    } else if (price === "low" || price === "high") {
      filtered = filtered.slice().sort((a, b) => {
        const pa = getEbayAvgNumber(a);
        const pb = getEbayAvgNumber(b);

        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;

        return price === "low" ? pa - pb : pb - pa;
      });
    }
  }


  grid.className = "vzla-grid";
grid.innerHTML = filtered.map(renderAthleteCard).join("");

// ✅ Re-run budget suggestions after cards re-render (optional feature)
if (typeof window.runBudgetSuggest === "function") {
  window.runBudgetSuggest();
}

  const countEl = document.getElementById("search-count");
  if (countEl) {
    countEl.innerHTML =
      `Showing <span style="color:rgba(255,255,255,.7)">${filtered.length}</span> ` +
      `of <span style="color:rgba(255,255,255,.7)">${(list || []).length}</span> players`;
  }

  const clearBtn = document.getElementById("search-clear");
  if (clearBtn) {
    clearBtn.style.display = q ? "inline-flex" : "none";
  }
}

function formatIndexNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(num));
}

function getSportCounts(list) {
  const counts = new Map();
  (list || []).forEach((a) => {
    const sport = a?.sport || "Other";
    counts.set(sport, (counts.get(sport) || 0) + 1);
  });
  return counts;
}

function computeIndexForSport(list, sportOrAll) {
  let sum = 0;
  let used = 0;

  (list || []).forEach((a) => {
    if (sportOrAll !== "All" && a.sport !== sportOrAll) return;

    const v = getEbayAvgNumber(a);
    if (v != null) {
      sum += v;
      used += 1;
    }
  });

  return { sum, used };
}

function makeIndexCardHTML({ title, badgeText, value, sub }) {
  return `
    <div class="vzla-index-card">
      <div class="vzla-index-top">
        <div class="vzla-index-title">
          <div class="vzla-index-badge">${badgeText}</div>
          <div>${title}</div>
        </div>
      </div>

      <div class="vzla-index-value">${value}</div>
      <div class="vzla-index-sub">${sub}</div>
    </div>
  `;
}

function renderIndexCards() {
  const row = document.getElementById("vzlaIndexRow");
  if (!row) return;

  const counts = getSportCounts(athleteData);

  const entries = Array.from(counts.entries())
    .filter(([sport]) => sport !== "Other")
    .sort((a, b) => b[1] - a[1]);

  const top1 = entries[0]?.[0] || "Baseball";
  const top2 = entries[1]?.[0] || "Soccer";

  const i1 = computeIndexForSport(athleteData, top1);
  const i2 = computeIndexForSport(athleteData, top2);
  const iAll = computeIndexForSport(athleteData, "All");

  row.innerHTML =
    makeIndexCardHTML({
      title: `${top1} Index`,
      badgeText: "I",
      value: formatIndexNumber(i1.sum),
      sub: `${counts.get(top1) || 0} athletes • ${i1.used} priced`,
    }) +
    makeIndexCardHTML({
      title: `${top2} Index`,
      badgeText: "I",
      value: formatIndexNumber(i2.sum),
      sub: `${counts.get(top2) || 0} athletes • ${i2.used} priced`,
    }) +
    makeIndexCardHTML({
      title: `All Index`,
      badgeText: "I",
      value: formatIndexNumber(iAll.sum),
      sub: `${athleteData.length} athletes • ${iAll.used} priced`,
    });
}

// ---------- Init ----------
async function init() {
  if (!document.getElementById("athletes-grid")) return;

  const [fetchedAthletes, fetchedEbayAvg] = await Promise.all([
    fetchJsonWithFallback("data/athletes.json"),
    fetchJsonWithFallback("data/ebay-avg.json"),
  ]);

  athleteData = mergeByNameSportKeepBest(athleteDataRaw, fetchedAthletes || []);
  ebayAvgRaw = fetchedEbayAvg && typeof fetchedEbayAvg === "object" ? fetchedEbayAvg : {};

  buildEbayIndexes(ebayAvgRaw);

  updateEbayLastUpdatedLabelFrom(ebayAvgRaw);
  setInterval(() => updateEbayLastUpdatedLabelFrom(ebayAvgRaw), 60 * 1000);

  setKbdHint();
  fillFilterOptions();

  const search = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear");

  const rerenderDebounced = debounce(() => renderGrid(athleteData), 150);

  if (search) {
    search.addEventListener("input", rerenderDebounced);

    window.addEventListener("keydown", (e) => {
      const isK = String(e.key || "").toLowerCase() === "k";
      if ((e.metaKey || e.ctrlKey) && isK) {
        e.preventDefault();
        search.focus();
      }
      if (e.key === "Escape") {
        search.blur();
      }
    });
  }

  if (clearBtn && search) {
    clearBtn.addEventListener("click", () => {
      search.value = "";
      renderGrid(athleteData);
      search.focus();
    });
  }

  const catSel = document.getElementById("filter-category");
  const leagueSel = document.getElementById("filter-league");
  const priceSel = document.getElementById("filter-price");
  const stabilitySel = document.getElementById("filter-stability");

  const rerenderNow = () => renderGrid(athleteData);

  if (catSel) catSel.addEventListener("change", rerenderNow);
  if (leagueSel) leagueSel.addEventListener("change", rerenderNow);
  if (priceSel) priceSel.addEventListener("change", rerenderNow);
  if (stabilitySel) stabilitySel.addEventListener("change", rerenderNow);

  renderGrid(athleteData);
  renderIndexCards();
}

document.addEventListener("DOMContentLoaded", init);
