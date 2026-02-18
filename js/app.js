// js/app.js

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
  { name: "Josef Martínez", sport: "Soccer", league: "MLS", team: "CF Montréal" },
  { name: "Salomón Rondón", sport: "Soccer", league: "Liga MX", team: "Pachuca" },
  { name: "Darwin Machís", sport: "Soccer", league: "La Liga", team: "Cádiz" },
  { name: "Jefferson Savarino", sport: "Soccer", league: "Serie A", team: "Botafogo" },
  { name: "Yangel Herrera", sport: "Soccer", league: "La Liga", team: "Girona" },

  { name: "Michael Carrera", sport: "Basketball", league: "LNBP", team: "Astros de Jalisco" },

  { name: "Daniel Dhers", sport: "Other", league: "BMX", team: "Individual" },
  { name: "Yulimar Rojas", sport: "Other", league: "Track & Field", team: "Individual" },
  { name: "Jhonattan Vegas", sport: "Other", league: "PGA", team: "Venezuela" },
  { name: "Garbiñe Muguruza", sport: "Tennis", league: "WTA", team: "Venezuela" },
  { name: "Marlon Vera", sport: "MMA", league: "UFC", team: "Venezuela" },
  { name: "Andres Borregales", sport: "Football", league: "NFL", team: "New England Patriots" },
  { name: "Amleto Monacelli", sport: "Other", league: "Bowling", team: "PBA50" }
];

let athleteData = [];
let ebayAvgRaw = {};
let activeSport = "All";

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
    ["league", "team", "tier", "sport"].reduce(
      (n, f) => n + (o?.[f] ? 1 : 0),
      0
    );

  const add = (a) => {
    const key = makeNameSportKey(a?.name, a?.sport);
    if (!key || key === "|") return;

    const prev = map.get(key);
    if (!prev) {
      map.set(key, a);
    } else {
      map.set(key, score(a) >= score(prev) ? a : prev);
    }
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

// ---------- eBay Avg Index ----------

const ebayAvgByName = {};
const ebayAvgByKey = {};

function buildEbayIndexes(obj) {
  Object.keys(ebayAvgByName).forEach(k => delete ebayAvgByName[k]);
  Object.keys(ebayAvgByKey).forEach(k => delete ebayAvgByKey[k]);

  if (!obj || typeof obj !== "object") return;

  for (const k of Object.keys(obj)) {
    if (k === "_meta") continue;

    const rec = obj[k];
    if (!rec) continue;

    if (k.includes("|")) {
      ebayAvgByKey[k] = rec;
      continue;
    }

    ebayAvgByName[k] = rec;

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

function formatCurrency(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";

  if ((currency || "").toUpperCase() === "CAD") {
    return `C$${n.toFixed(2)}`;
  }

  if ((currency || "").toUpperCase() === "USD") {
    return `$${n.toFixed(2)}`;
  }

  return `${(currency || "").toUpperCase()} ${n.toFixed(2)}`;
}

function buildEbaySearchUrl(name, sport) {
  const sportPart = sport ? ` ${sport}` : "";
  const q = encodeURIComponent(`${name}${sportPart}`);
  return `https://www.ebay.ca/sch/i.html?_nkw=${q}&mkevt=1&mkcid=1&mkrid=706-53473-19255-0&campid=5339142321&toolid=10001`;
}

// ---------- UI ----------

function setSport(sport, btn) {
  activeSport = sport;

  const filterBar = document.getElementById("sport-filters");
  if (filterBar) {
    filterBar.querySelectorAll("button").forEach(b => {
      b.classList.remove("text-[#f2f20d]");
      b.classList.add("text-slate-500");
    });
  }

  if (btn) {
    btn.classList.remove("text-slate-500");
    btn.classList.add("text-[#f2f20d]");
  }

  renderGrid(athleteData);
}

// Make sure inline onclick="setSport(...)" works
window.setSport = setSport;

function renderGrid(list) {
  const grid = document.getElementById("athletes-grid");
  if (!grid) return;

  const q = norm(document.getElementById("search-input")?.value || "");

  const filtered = (list || [])
    .filter(a => activeSport === "All" || a.sport === activeSport)
    .filter(a => !q || norm(a.name).includes(q));

  // Updated grid layout for consistency
  grid.className = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10 mt-10 w-full max-w-7xl mx-auto";

  grid.innerHTML = filtered.map(a => {
    const avg = getEbayAvgFor(a);
    const avgNum = avg?.avgListing ?? avg?.avg_list_price ?? avg?.avgListPrice ?? avg?.avg ?? avg?.average ?? null;
    const currency = avg?.currency || "CAD";
    const money = avgNum != null && Number.isFinite(Number(avgNum)) ? formatCurrency(avgNum, currency) : "";
    const shopUrl = buildEbaySearchUrl(a.name, a.sport);

    return `
      <main class="athlete-card bg-[#121212] border border-white/10 rounded-[40px] p-8 w-full shadow-2xl flex flex-col items-center text-center justify-between min-h-[320px]" data-purpose="athlete-display-card">
        
        <header class="mb-6">
          <h1 class="athlete-name text-white text-3xl font-black italic uppercase mb-1 leading-tight tracking-tighter">
            ${a.name}
          </h1>
          <div class="flex items-center justify-center space-x-2 text-[#8e8e93] font-bold text-[11px] tracking-[0.2em] uppercase">
            <span>${a.sport}</span>
            <span class="w-1.5 h-1.5 bg-green-500 rounded-full inline-block mx-1"></span>
            <span>${a.team || a.sport}</span>
          </div>
        </header>
        <a href="${shopUrl}" 
           target="_blank" 
           rel="noopener noreferrer"
           class="shop-btn bg-[#f2f20d] w-full rounded-full py-4 px-6 flex flex-col items-center justify-center transition-transform hover:scale-[1.03] active:scale-[0.98] no-underline shadow-lg" 
           data-purpose="shop-collectibles-button">
          
          <span class="text-black font-black text-xl tracking-tighter uppercase leading-none">
            Shop Collectibles
          </span>
          
          ${money ? `
            <span class="text-black font-bold text-[11px] tracking-tight uppercase leading-none mt-2 opacity-80">
              (Avg List: ${money})
            </span>
          ` : ''}
        </a>
        </main>
    `;
  }).join("");
}

// ---------- Init ----------

async function init() {
  if (!document.getElementById("athletes-grid")) return;

  const [fetchedAthletes, fetchedEbayAvg] = await Promise.all([
    fetchJsonWithFallback("data/athletes.json"),
    fetchJsonWithFallback("data/ebay-avg.json"),
  ]);

  athleteData = mergeByNameSportKeepBest(
    athleteDataRaw,
    fetchedAthletes || []
  );

  ebayAvgRaw =
    fetchedEbayAvg && typeof fetchedEbayAvg === "object"
      ? fetchedEbayAvg
      : {};

  buildEbayIndexes(ebayAvgRaw);

  const search = document.getElementById("search-input");
  if (search) {
    search.addEventListener("input", () => renderGrid(athleteData));
  }

  renderGrid(athleteData);
}

document.addEventListener("DOMContentLoaded", init);
