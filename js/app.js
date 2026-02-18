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

  { name: "Daniel Dhers", sport: "BMX", league: "BMX", team: "Individual" },
  { name: "Yulimar Rojas", sport: "Other", league: "Track & Field", team: "Individual" },
  { name: "Jhonattan Vegas", sport: "Golf", league: "PGA", team: "Venezuela" },
  { name: "Garbiñe Muguruza", sport: "Tennis", league: "WTA", team: "Venezuela" },
  { name: "Marlon Vera", sport: "MMA", league: "UFC", team: "Venezuela" },
  { name: "Andres Borregales", sport: "Football", league: "NFL", team: "New England Patriots" },
  { name: "Amleto Monacelli", sport: "Bowling", league: "PBA50", team: "PBA50" }
];

let athleteData = [];
let ebayAvgRaw = {};
let activeSport = "All";

/* ---------------- Helpers ---------------- */

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function makeNameSportKey(name, sport) {
  return `${norm(name)}|${norm(sport)}`;
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

/* ---------------- eBay Avg ---------------- */

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
  const key = makeNameSportKey(athlete.name, athlete.sport);
  return ebayAvgByKey[key] || ebayAvgByName[athlete.name] || null;
}

function formatCurrency(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";

  if ((currency || "").toUpperCase() === "CAD") return `C$${n.toFixed(2)}`;
  if ((currency || "").toUpperCase() === "USD") return `$${n.toFixed(2)}`;

  return `${(currency || "").toUpperCase()} ${n.toFixed(2)}`;
}

function buildEbaySearchUrl(name, sport) {
  const sportPart = sport ? ` ${sport}` : "";
  const q = encodeURIComponent(`${name}${sportPart}`);
  return `https://www.ebay.ca/sch/i.html?_nkw=${q}&mkevt=1&mkcid=1&mkrid=706-53473-19255-0&campid=5339142321&toolid=10001`;
}

/* ---------------- UI ---------------- */

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
    .filter(a => activeSport === "All" || a.sport === activeSport)
    .filter(a => !q || norm(a.name).includes(q));

  grid.className =
    "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 xl:grid-cols-3 gap-8 mt-10";

  grid.innerHTML = filtered.map(a => {
    const avg = getEbayAvgFor(a);

    const avgNum =
      avg?.avgListing ??
      avg?.avg_list_price ??
      avg?.avgListPrice ??
      avg?.avg ??
      avg?.average ??
      null;

    const currency = avg?.currency || "CAD";

    const money =
      avgNum != null && Number.isFinite(Number(avgNum))
        ? formatCurrency(avgNum, currency)
        : "";

    const shopUrl = buildEbaySearchUrl(a.name, a.sport);

    return `
      <div class="athlete-card p-8 bg-[#121212] rounded-[20px] border border-white/10 shadow-xl text-center flex flex-col items-center">

        <div class="text-white text-2xl font-black italic uppercase mb-2 tracking-tight">
          ${a.name}
        </div>

        <div class="flex items-center justify-center space-x-2 text-[#8e8e93] font-bold text-[9px] tracking-[0.15em] uppercase mb-6">
          <span>${a.sport}</span>
          <span class="w-1.5 h-1.5 bg-green-500 rounded-full inline-block"></span>
          <span>${a.team || a.sport}</span>
        </div>

        <a
          href="${shopUrl}"
          target="_blank"
          rel="noopener noreferrer"
          class="w-full rounded-full bg-[#f2f20d] px-6 py-4 flex flex-col items-center justify-center transition-transform hover:scale-[1.02] active:scale-[0.98]"
        >
          <span class="text-black font-black uppercase text-[8px] leading-tight tracking-tight">
            Shop Collectibles
          </span>

          ${money ? `
            <span class="text-black font-bold uppercase text-[5px] leading-tight tracking-tight opacity-90 mt-1">
              (Avg List: ${money})
            </span>
          ` : ``}
        </a>

      </div>
    `;
  }).join("");
}

/* ---------------- Init ---------------- */

async function init() {
  if (!document.getElementById("athletes-grid")) return;

  const fetchedEbayAvg = await fetchJsonWithFallback("data/ebay-avg.json");

  athleteData = athleteDataRaw;
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
