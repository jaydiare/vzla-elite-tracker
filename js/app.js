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
  { name: "Josef Martinez", sport: "Soccer", league: "MLS", team: "CF Montréal" },
  { name: "Salomon Rondon", sport: "Soccer", league: "Liga MX", team: "Pachuca" },
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

  const c = String(currency || "").toUpperCase();
  if (c === "CAD") return `C$${n.toFixed(2)}`;
  if (c === "USD") return `$${n.toFixed(2)}`;
  return `${c} ${n.toFixed(2)}`;
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
      : "—";

  const shopUrl = buildEbaySearchUrl(a.name, a.sport);
  const initials = initialsFromName(a.name);

  // Placeholder for 30d change (until you have that data)
  const chgText = "—";
  const chgClass = "chg-neutral";

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
    <div class="athlete-card__label">eBay Avg listing price</div>

    <a href="${shopUrl}" target="_blank"
       class="athlete-card__cta">
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

  const q = norm(document.getElementById("search-input")?.value || "");

  const filtered = (list || [])
    .filter((a) => {
      if (activeSport === "All") return true;
      if (activeSport === "Other") {
        return !["Baseball", "Soccer", "Basketball"].includes(a.sport);
      }
      return a.sport === activeSport;
    })
    .filter((a) => !q || norm(a.name).includes(q));

  grid.className = "vzla-grid";
  grid.innerHTML = filtered.map(renderAthleteCard).join("");
}

// ---------- Init ----------
async function init() {
  if (!document.getElementById("athletes-grid")) return;

  const [fetchedAthletes, fetchedEbayAvg] = await Promise.all([
    fetchJsonWithFallback("data/athletes.json"),
    fetchJsonWithFallback("data/ebay-avg.json"),
  ]);

  athleteData = mergeByNameSportKeepBest(athleteDataRaw, fetchedAthletes || []);

  ebayAvgRaw =
    fetchedEbayAvg && typeof fetchedEbayAvg === "object" ? fetchedEbayAvg : {};

  buildEbayIndexes(ebayAvgRaw);

  updateEbayLastUpdatedLabelFrom(ebayAvgRaw);
  setInterval(() => updateEbayLastUpdatedLabelFrom(ebayAvgRaw), 60 * 1000);

  const search = document.getElementById("search-input");
  if (search) search.addEventListener("input", () => renderGrid(athleteData));

  renderGrid(athleteData);
}

document.addEventListener("DOMContentLoaded", init);
