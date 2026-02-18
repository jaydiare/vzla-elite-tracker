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
  { name: "Josef Martínez", sport: "Soccer", league: "MLS", team: "CF Montréal" },
  { name: "Salomón Rondón", sport: "Soccer", league: "Liga MX", team: "Pachuca" },
  { name: "Darwin Machís", sport: "Soccer", league: "La Liga", team: "Cádiz" },
  { name: "Jefferson Savarino", sport: "Soccer", league: "Serie A", team: "Botafogo" },
  { name: "Yangel Herrera", sport: "Soccer", league: "La Liga", team: "Girona" },
  { name: "Wuilker Faríñez", sport: "Soccer", league: "Unknown", team: "Unknown" },

  { name: "Garly Sojo", sport: "Basketball", league: "Unknown", team: "Unknown" },
  { name: "Michael Carrera", sport: "Basketball", league: "Unknown", team: "Unknown" },
  { name: "Greivis Vásquez", sport: "Basketball", league: "NBA", team: "Retired" },

  { name: "Daniel Dhers", sport: "Other", league: "BMX", team: "Individual" },
  { name: "Yulimar Rojas", sport: "Other", league: "Track & Field", team: "Individual" },
];

let athleteData = [];
let ebayAvgRaw = {};
let activeSport = "All";

// --------- helpers ----------
function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function makeNameSportKey(name, sport) {
  return `${norm(name)}|${norm(sport)}`;
}

function mergeByNameSportKeepBest(localArr, fetchedArr) {
  const map = new Map();
  const add = (a) => {
    const k = makeNameSportKey(a?.name, a?.sport);
    if (!k || k === "|") return;
    const prev = map.get(k);
    if (!prev) map.set(k, a);
    else {
      // prefer record with more fields filled
      const score = (o) => ["league","team","tier","sport"].reduce((n,f)=>n+(o?.[f]?1:0),0);
      map.set(k, score(a) >= score(prev) ? a : prev);
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

// --------- ebay avg index ----------
const ebayAvgByName = {};
const ebayAvgByKey = {};

function buildEbayIndexes(obj) {
  Object.keys(ebayAvgByName).forEach(k => delete ebayAvgByName[k]);
  Object.keys(ebayAvgByKey).forEach(k => delete ebayAvgByKey[k]);

  if (!obj || typeof obj !== "object") return;

  for (const k of Object.keys(obj)) {
    const rec = obj[k];
    if (!rec) continue;

    if (k.includes("|")) {
      ebayAvgByKey[k] = rec;
      continue;
    }

    const name = k;
    ebayAvgByName[name] = rec;

    if (rec?.sport) {
      ebayAvgByKey[makeNameSportKey(name, rec.sport)] = rec;
    }
  }
}

function getEbayAvgFor(athlete) {
  if (!athlete) return null;
  const k = makeNameSportKey(athlete.name, athlete.sport);
  return ebayAvgByKey[k] || ebayAvgByName[athlete.name] || null;
}

function buildEbaySearchUrl(name) {
  const q = encodeURIComponent(name + " card");
  return `https://www.ebay.ca/sch/i.html?_nkw=${q}&mkevt=1&mkcid=1&mkrid=706-53473-19255-0&campid=5339142321&toolid=10001`;
}

// --------- UI ----------
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

function renderGrid(list) {
  const grid = document.getElementById("athletes-grid");
  if (!grid) return;

  const q = norm(document.getElementById("search-input")?.value || "");
  const filtered = (list || [])
    .filter(a => activeSport === "All" ? true : a.sport === activeSport)
    .filter(a => !q ? true : norm(a.name).includes(q));

  grid.innerHTML = filtered.map(a => {
    const avg = getEbayAvgFor(a);
    const avgTxt = avg?.avg_list_price ? ` (AVG LIST: C$${Number(avg.avg_list_price).toFixed(2)})` : "";
    const leagueTeam = `${a.sport} • ${a.team || "Unknown"}`;
    const shopUrl = buildEbaySearchUrl(a.name);

    return `
      <div class="athlete-card p-8 bg-white/5 rounded-3xl border border-white/10 text-center">
        <div class="inline-block px-4 py-2 rounded-full bg-[#f2f20d] text-black font-black text-[11px] tracking-widest uppercase mb-5">
          ELITE TIER
        </div>

        <div class="text-3xl font-black italic uppercase">${a.name}</div>

        <div class="mt-3 text-slate-400 font-black tracking-widest uppercase text-[11px]">
          <span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span>
          ${leagueTeam}
        </div>

        <a href="${shopUrl}" target="_blank" rel="noopener noreferrer"
           class="mt-7 inline-block w-full px-4 py-4 rounded-full bg-[#f2f20d] text-black font-black tracking-widest uppercase text-[12px] hover:opacity-90 transition">
          SHOP COLLECTIBLES${avgTxt}
        </a>
      </div>
    `;
  }).join("");
}

async function init() {
  // ✅ Guard: only run on pages that actually have the grid
  const grid = document.getElementById("athletes-grid");
  if (!grid) return;

  const [fetchedAthletes, fetchedEbayAvg] = await Promise.all([
    fetchJsonWithFallback("data/athletes.json"),
    fetchJsonWithFallback("data/ebay-avg.json"),
  ]);

  athleteData = mergeByNameSportKeepBest(athleteDataRaw, fetchedAthletes);
  ebayAvgRaw = fetchedEbayAvg && typeof fetchedEbayAvg === "object" ? fetchedEbayAvg : {};
  buildEbayIndexes(ebayAvgRaw);

  const search = document.getElementById("search-input");
  if (search) {
    search.addEventListener("input", () => renderGrid(athleteData));
  }

  renderGrid(athleteData);
}

document.addEventListener("DOMContentLoaded", init);
