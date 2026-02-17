// js/app.js

// FULL fixed fallback list (same as your index.html)
const athleteDataRaw = [
  { name: "Ronald Acuña Jr.", sport: "Baseball", league: "MLB", team: "Braves" },
  { name: "Jackson Chourio", sport: "Baseball", league: "MLB", team: "Brewers" },
  { name: "Maikel Garcia", sport: "Baseball", league: "MLB", team: "Royals" },
  { name: "Salvador Perez", sport: "Baseball", league: "MLB", team: "Royals" },
  { name: "Eugenio Suárez", sport: "Baseball", league: "MLB", team: "Diamondbacks" },
  { name: "Jose Altuve", sport: "Baseball", league: "MLB", team: "Astros" },
  { name: "Luis Arraez", sport: "Baseball", league: "MLB", team: "Padres" },
  { name: "William Contreras", sport: "Baseball", league: "MLB", team: "Brewers" },
  { name: "Anthony Santander", sport: "Baseball", league: "MLB", team: "Orioles" },
  { name: "Wilyer Abreu", sport: "Baseball", league: "MLB", team: "Red Sox" },
  { name: "Eduardo Rodriguez", sport: "Baseball", league: "MLB", team: "Diamondbacks" },
  { name: "Francisco Alvarez", sport: "Baseball", league: "MLB", team: "Mets" },

  { name: "Yeferson Soteldo", sport: "Soccer", league: "Serie A", team: "Grêmio" },
  { name: "Jon Aramburu", sport: "Soccer", league: "La Liga", team: "Real Sociedad" },
  { name: "Nahuel Ferraresi", sport: "Soccer", league: "Série A", team: "São Paulo" },
  { name: "Cristian Cásseres Jr.", sport: "Soccer", league: "Ligue 1", team: "Toulouse" },
  { name: "Telasco Segovia", sport: "Soccer", league: "Primeira Liga", team: "Casa Pia" },
  { name: "Jefferson Savarino", sport: "Soccer", league: "Série A", team: "Botafogo" },
  { name: "David Martínez", sport: "Soccer", league: "MLS", team: "LAFC" },
  { name: "Salomon Rondon", sport: "Soccer", league: "La Liga MX", team: "Pachuca" },
  { name: "Yangel Herrera", sport: "Soccer", league: "La Liga", team: "Real Sociedad" },

  { name: "Michael Carrera", sport: "Basketball", league: "LEB Oro", team: "Estudiantes" },
  { name: "Heissler Guillent", sport: "Basketball", league: "LNBP", team: "Astros" },
  { name: "David Cubillan", sport: "Basketball", league: "SLB", team: "Trotamundos" },
  { name: "Jose Ascanio", sport: "Basketball", league: "Liga Nacional", team: "Oberá" },
  { name: "Pedro Chourio", sport: "Basketball", league: "NBB", team: "São José" },

  { name: "Jhonattan Vegas", sport: "Golf", league: "PGA", team: "Venezuela" },
  { name: "Garbiñe Muguruza", sport: "Tennis", league: "WTA", team: "Venezuela" },
  { name: "Marlon Vera", sport: "MMA", league: "UFC", team: "Venezuela" },
  { name: "Andres Borregales", sport: "Football", league: "NFL", team: "New England Patriots" },
  { name: "Amleto Monacelli", sport: "Bowling", league: "PBA50", team: "Unknown" }
];

let athleteData = [];
let currentSport = "All";

// ebay averages cache
// NOTE: we now support lookup by (name + sport) key (more accurate),
// but we keep the old by-name fallback for backward compatibility.
let ebayAvgRaw = {};      // raw JSON object from data/ebay-avg.json
let ebayAvgByKey = {};    // normalized "name|sport" -> record
let ebayAvgByName = {};   // exact name -> record (legacy)
const MIN_EBAY_SAMPLE_SIZE = 5;

const campID = "5339142321";
const rotationID = "706-53473-19255-0";

const norm = (v) => (v || "").toString().trim().toLowerCase();
const isUnknown = (v) => {
  const s = norm(v);
  return !s || s === "unknown" || s === "n/a" || s === "na" || s === "-";
};

function stripDiacritics(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Build a stable matching key (name + sport), ignoring accents/case
function makeNameSportKey(name, sport) {
  const n = stripDiacritics(norm(name));
  const sp = stripDiacritics(norm(sport));
  return `${n}|${sp}`;
}

// Prefer best duplicate record for same (name+sport)
function scoreAthlete(a) {
  let score = 0;
  if (!isUnknown(a?.team)) score += 3;
  if (!isUnknown(a?.league)) score += 2;
  if (!isUnknown(a?.sport)) score += 1;
  return score;
}

function mergeByNameSportKeepBest(fixedList, fetchedList) {
  const all = [];

  for (const a of (fixedList || [])) {
    all.push({
      name: a?.name || "Unknown",
      sport: a?.sport || "Other",
      league: a?.league || "",
      team: a?.team || "Unknown",
    });
  }

  if (Array.isArray(fetchedList)) {
    for (const a of fetchedList) {
      all.push({
        name: a?.name || "Unknown",
        sport: a?.sport || "Other",
        league: a?.league || "",
        team: a?.team || "Unknown",
      });
    }
  }

  const map = new Map();
  for (const a of all) {
    const key = `${norm(a.name)}|${norm(a.sport)}`;
    if (!map.has(key)) {
      map.set(key, a);
      continue;
    }
    const cur = map.get(key);
    if (scoreAthlete(a) > scoreAthlete(cur)) map.set(key, a);
  }

  return Array.from(map.values()).sort((x, y) => x.name.localeCompare(y.name));
}

async function fetchJsonWithFallback(filePath) {
  const cacheBust = `v=${Date.now()}`;

  const origins = Array.from(new Set([
    window.location.origin,
    window.location.origin.replace("://www.", "://"),
    window.location.origin.includes("://www.")
      ? window.location.origin
      : window.location.origin.replace("://", "://www.")
  ]));

  const paths = origins.map(o => `${o}/${filePath}?${cacheBust}`);
  paths.push(`./${filePath}?${cacheBust}`);

  for (const url of paths) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {}
  }
  return null;
}

function formatCad(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  return `C$${num.toFixed(2)}`;
}

/**
 * Button label:
 * - Requires a minimum active-listing sample size to show pricing
 * - Shows AVG LIST (and also AVG SOLD if your JSON still contains it from older runs)
 * - CAD-only
 *
 * IMPORTANT: now matches by (name + sport) first, then falls back to old by-name key.
 */
function getShopLabelForAthlete(athlete) {
  const name = athlete?.name || "";
  const sport = athlete?.sport || "";

  // 1) Most accurate: normalized name|sport
  const key = makeNameSportKey(name, sport);
  let rec = ebayAvgByKey?.[key];

  // 2) Back-compat fallback: exact name key if older JSON was keyed that way
  if (!rec) rec = ebayAvgByName?.[name];

  if (!rec) return "SHOP COLLECTIBLES";

  // ---- Active listing (what you have scope for now) ----
  // Support a few possible field names, depending on what your script writes.
  const avgListing = Number(
    rec.avgListing ??
    rec.avgActive ??
    rec.avgList ??
    NaN
  );

  const nListing = Number(
    rec.nListing ??
    rec.nActive ??
    rec.nList ??
    rec.n ??
    0
  );

  if (!Number.isFinite(avgListing) || !nListing || nListing < MIN_EBAY_SAMPLE_SIZE) {
    return "SHOP COLLECTIBLES";
  }

  // Keep label consistent in CAD only
  if (rec.currency && rec.currency !== "CAD") return "SHOP COLLECTIBLES";

  const listingMoney = formatCad(avgListing);
  if (!listingMoney) return "SHOP COLLECTIBLES";

  // ---- Optional: Sold fields still displayed if present from an old file ----
  const avgSold = Number(rec.avgSold ?? rec.avg ?? NaN);
  const nSold = Number(rec.nSold ?? 0);

  const soldOk = Number.isFinite(avgSold) && nSold >= MIN_EBAY_SAMPLE_SIZE;
  const soldMoney = soldOk ? formatCad(avgSold) : null;

  if (soldMoney) {
    return `SHOP COLLECTIBLES (AVG SOLD: ${soldMoney} • AVG LIST: ${listingMoney})`;
  }
  return `SHOP COLLECTIBLES (AVG LIST: ${listingMoney})`;
}

function filterBySearch() {
  const query = (document.getElementById("athleteSearch")?.value || "").toLowerCase();

  const filtered = athleteData.filter(a => {
    const matchesQuery = (a.name || "").toLowerCase().includes(query);

    let matchesSport = false;
    if (currentSport === "All") matchesSport = true;
    else if (currentSport === "Other") {
      const mainSports = ["Baseball", "Soccer", "Basketball"];
      matchesSport = !mainSports.includes(a.sport);
    } else {
      matchesSport = (a.sport === currentSport);
    }

    return matchesQuery && matchesSport;
  });

  renderGrid(filtered);
}

// Expose for inline onclick handlers in HTML
window.setSport = function setSport(sport, btn) {
  currentSport = sport;

  document.querySelectorAll("#sport-filters button")
    .forEach(b => b.classList.replace("text-[#f2f20d]", "text-slate-500"));

  btn.classList.replace("text-slate-500", "text-[#f2f20d]");
  filterBySearch();
};

// Expose for onkeyup handler
window.filterBySearch = filterBySearch;

function renderGrid(data) {
  const grid = document.getElementById("athletes-grid");
  if (!grid) return;

  grid.innerHTML = (data || []).map(a => {
    const ebaySearchURL =
      `https://www.ebay.ca/sch/i.html?_nkw=${encodeURIComponent(`${a.name} ${a.sport}`)}&mkevt=1&mkcid=1&mkrid=${rotationID}&campid=${campID}&toolid=10001`;

    const teamLabel = isUnknown(a.team) ? "Unknown" : a.team;

    // NOTE: pass the whole athlete so we can match by name + sport
    const shopLabel = getShopLabelForAthlete(a);

    return `
      <div class="athlete-card">
        <div>
          <div class="elite-pill">ELITE TIER</div>
          <h3 class="athlete-name">${a.name}</h3>

          <div class="status-row">
            <span class="status-dot"></span>
            <span class="status-text">${a.sport} • ${teamLabel}</span>
          </div>
        </div>

        <a href="${ebaySearchURL}" target="_blank" class="shop-btn">
          ${shopLabel}
        </a>
      </div>
    `;
  }).join("");
}

/**
 * Normalize whatever ebay-avg.json shape you have into:
 * - ebayAvgByKey: normalized "name|sport" -> record
 * - ebayAvgByName: exact name -> record (legacy fallback)
 *
 * Supports:
 *  A) Object keyed by "name|sport"
 *  B) Object keyed by athlete name
 *  C) Array of records with { name, sport, ... }
 */
function buildEbayIndexes(raw) {
  ebayAvgByKey = {};
  ebayAvgByName = {};

  if (!raw) return;

  // If array: [{name, sport, ...}, ...]
  if (Array.isArray(raw)) {
    for (const rec of raw) {
      const name = rec?.name;
      const sport = rec?.sport;
      if (name && sport) {
        ebayAvgByKey[makeNameSportKey(name, sport)] = rec;
      }
      if (name && !ebayAvgByName[name]) {
        ebayAvgByName[name] = rec;
      }
    }
    return;
  }

  // If object
  if (typeof raw === "object") {
    for (const [k, rec] of Object.entries(raw)) {
      // If key already looks like "name|sport", try to treat it as such
      if (k.includes("|")) {
        ebayAvgByKey[k] = rec;
        continue;
      }

      // Otherwise assume legacy keyed by exact name
      const name = k;
      ebayAvgByName[name] = rec;

      // If record contains sport too, also index by normalized key
      if (rec?.sport) {
        ebayAvgByKey[makeNameSportKey(name, rec.sport)] = rec;
      }
    }
  }
}

async function init() {
  const [fetchedAthletes, fetchedEbayAvg] = await Promise.all([
    fetchJsonWithFallback("data/athletes.json"),
    fetchJsonWithFallback("data/ebay-avg.json"),
  ]);

  athleteData = mergeByNameSportKeepBest(athleteDataRaw, fetchedAthletes);

  ebayAvgRaw = fetchedEbayAvg && typeof fetchedEbayAvg === "object" ? fetchedEbayAvg : {};
  buildEbayIndexes(ebayAvgRaw);

  renderGrid(athleteData);
}

init();
