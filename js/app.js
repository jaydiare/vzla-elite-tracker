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

function initialsFromName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "VZ";
  const a = parts[0]?.[0] || "";
  const b = parts.length > 1 ? (parts[1]?.[0] || "") : (parts[0]?.[1] || "");
  return (a + b).toUpperCase();
}

/* =========================
   eBay Data Index
========================= */

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

function getEbayAvgNumber(athlete) {
  const avg = getEbayAvgFor(athlete);

  const avgNum =
    avg?.avgListing ??
    avg?.taguchiListing ??
    avg?.avg ??
    null;

  if (avgNum == null) return null;

  const v = Number(avgNum);
  if (!Number.isFinite(v) || v <= 0) return null;

  return v;
}

/* =========================
   Market Stability (CV)
========================= */

function getMarketStabilityCV(athlete) {
  const rec = getEbayAvgFor(athlete);
  const v = rec?.marketStabilityCV ?? null;

  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function marketStabilityScoreFromCV(cv) {
  if (cv == null) return { label: "—", pctText: "—" };

  const pct = cv * 100;
  const pctText = `${pct.toFixed(0)}%`;

  if (pct < 10) return { label: "Stable", pctText };
  if (pct < 20) return { label: "Active", pctText };
  return { label: "Volatile", pctText };
}

/* =========================
   Rendering
========================= */

function formatCurrency(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function buildEbaySearchUrl(name, sport) {
  const base = "https://www.ebay.ca/sch/i.html";
  const query = encodeURIComponent(`${name} ${sport}`);
  return `${base}?_nkw=${query}&_sacat=261328&LH_BIN=1`;
}

function renderAthleteCard(a) {
  const avgNum = getEbayAvgNumber(a);
  const money = avgNum != null ? `USD ${formatCurrency(avgNum)}` : "—";

  const cv = getMarketStabilityCV(a);
  const stability = marketStabilityScoreFromCV(cv);

  const shopUrl = buildEbaySearchUrl(a.name, a.sport);
  const initials = initialsFromName(a.name);

  return `
    <article class="athlete-card">
      <div class="athlete-card__top">
        <div class="athlete-card__avatar">${initials}</div>
        <div>
          <div class="athlete-card__name">${a.name}</div>
          <div class="athlete-card__pill">${a.sport}</div>
        </div>
      </div>

      <div class="athlete-card__value">${money}</div>
      <div class="athlete-card__label">eBay Robust Avg Listing</div>

      <div class="athlete-card__stability">
        Market Stability:
        <strong>${stability.label}</strong>
        (${stability.pctText})
      </div>

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

  grid.innerHTML = (list || []).map(renderAthleteCard).join("");
}

/* =========================
   Init
========================= */

async function init() {
  const fetchedEbayAvg = await fetchJsonWithFallback("data/ebay-avg.json");

  athleteData = athleteDataRaw;
  ebayAvgRaw = fetchedEbayAvg || {};

  buildEbayIndexes(ebayAvgRaw);

  renderGrid(athleteData);
}

document.addEventListener("DOMContentLoaded", init);
