// scripts/update-ebay-avg.js
// Node 20+ (uses global fetch)
//
// Computes ACTIVE listing average price from eBay Browse API:
// - Buy It Now only (FIXED_PRICE) => excludes auctions
// - Dual marketplace: EBAY_US + EBAY_CA (+ EBAY_ES if you keep it)
//
// Env vars required:
//   EBAY_CLIENT_ID
//   EBAY_CLIENT_SECRET
//
// Output:
//   data/ebay-avg.json
//
// Matching rules (your latest):
// 1) Prefer Player/Athlete aspect_filter match (with name variations / accents).
// 2) If Player/Athlete is NOT matched, then only proceed if Sport aspect matches.
// 3) If no Player/Athlete AND sport does not match => skip (avoid fake info).
//
// Notes:
// - Includes graded + listings under $1 (no price floor).
// - Category used: Trading Card Singles (261328) - keep or change as needed.
// - NEW: Converts listing prices to CAD using CBSA Exchange Rates API.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  console.error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in env.");
  process.exit(1);
}

const OUT_PATH = path.join(__dirname, "..", "data", "ebay-avg.json");

// This script expects:
// data/athletes.json: [{ name: "Jose Altuve", sport: "Baseball" }, ...]
const ATHLETES_PATH = path.join(__dirname, "..", "data", "athletes.json");

// Category you were using (Trading Card Singles)
const CATEGORY_ID = "261328";

// Listing sampling
const LISTING_PAGE_LIMIT = 100; // max active listings to average per marketplace
const PAGE_SIZE = 60;

// Your UI threshold
const MIN_EBAY_SAMPLE_SIZE = 8;

// Marketplaces to compute
const MARKETPLACES = ["EBAY_US", "EBAY_CA", "EBAY_ES"];

// --- helpers ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripDiacritics(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// Normalized name for comparisons (accents removed, punctuation softened)
function normalizeNameForCompare(s) {
  return normSpaces(
    stripDiacritics(s)
      .toLowerCase()
      .replace(/[.'’"]/g, "") // remove common punctuation in names
      .replace(/\b(jr|jr\.|sr|sr\.)\b/g, "")
  );
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  if (!values.length) return null;
  const s = values.reduce((a, b) => a + b, 0);
  return s / values.length;
}

function getHeaderMarketplace(marketplaceId) {
  return { "X-EBAY-C-MARKETPLACE-ID": marketplaceId };
}

// Build a search query. Keep it broad enough to find inventory but specific enough to reduce junk.
function buildQuery(name, sport) {
  const sportHint = sport ? ` ${sport}` : "";
  return `${name}${sportHint} card`;
}

// Map your sports to likely eBay "Sport" aspect values in Trading Card Singles.
// (We try multiple candidates for safety.)
function sportAspectCandidates(sportRaw) {
  const s = (sportRaw || "").toLowerCase().trim();

  // Common eBay aspect values tend to be Title Case
  // (fixed duplicate "football" key)
  const map = {
    baseball: ["Baseball"],
    soccer: ["Soccer"],
    football: ["Football"],
    basketball: ["Basketball"],
    golf: ["Golf"],
    tennis: ["Tennis"],
    mma: ["MMA", "Mixed Martial Arts"],
    bowling: ["Bowling"],
    olympics: ["Track & Field"],
    other: [],
  };

  return map[s] || [sportRaw];
}

// --- FX (USD/EUR -> CAD) ---
// CBSA Exchange Rates API (rates are CAD per 1 unit of foreign currency)
const CBSA_FX_URL =
  "https://bcd-api-dca-ipa.cbsa-asfc.cloud-nuage.canada.ca/exchange-rate-lambda/exchange-rates";

async function getFxRatesToCAD() {
  const res = await fetch(CBSA_FX_URL, {
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to fetch FX rates (${res.status}): ${txt}`);
  }

  const json = await res.json();
  const rows = json?.ForeignExchangeRates || json?.foreignExchangeRates || [];

  // Build: { CAD: 1, USD: <cad_per_usd>, EUR: <cad_per_eur>, ... }
  const rates = { CAD: 1 };
  let asOf = null;

  for (const r of rows) {
    const from = String(r?.FromCurrency?.Value || r?.FromCurrency || "").toUpperCase();
    const to = String(r?.ToCurrency?.Value || r?.ToCurrency || "").toUpperCase();
    const rate = Number(r?.Rate);

    if (to === "CAD" && Number.isFinite(rate) && rate > 0 && from) {
      rates[from] = rate;
      asOf =
        asOf ||
        r?.ExchangeRateEffectiveTimestamp ||
        r?.ValidStartDate ||
        r?.ExchangeRateExpiryTimestamp ||
        null;
    }
  }

  return { rates, asOf };
}

function convertToCAD(amount, currency, fxRates) {
  const cur = String(currency || "").toUpperCase();
  if (!Number.isFinite(amount)) return { cad: null, rateUsed: null };

  if (!cur || cur === "CAD") return { cad: amount, rateUsed: 1 };

  const rate = fxRates?.[cur];
  if (!Number.isFinite(rate)) return { cad: null, rateUsed: null };

  return { cad: amount * rate, rateUsed: rate };
}

// --- eBay auth ---
async function getAppToken() {
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      // Browse API only (no marketplace insights scope)
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to get eBay token (${res.status}): ${txt}`);
  }

  const json = await res.json();
  if (!json.access_token) throw new Error("No access_token in token response");
  return json.access_token;
}

// --- eBay Browse Search ---
async function ebayBrowseSearch({
  token,
  marketplaceId,
  q,
  categoryId,
  limit,
  offset,
  aspectFilter,
}) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("category_ids", categoryId);

  // Buy It Now only (exclude auctions)
  url.searchParams.append("filter", "buyingOptions:{FIXED_PRICE}");

  if (aspectFilter) {
    // aspect_filter format: "Player/Athlete:{Jose Altuve}"
    url.searchParams.set("aspect_filter", aspectFilter);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...getHeaderMarketplace(marketplaceId),
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Browse search failed (${marketplaceId}) ${res.status}: ${txt}`);
  }

  return res.json();
}

// --- Matching / Validation ---

function candidateAspectValuesForName(name) {
  // Try variants that often appear in eBay aspect values (accents/suffix/punctuation).
  const raw = normSpaces(name);

  const ascii = normSpaces(stripDiacritics(raw));
  const noDotsRaw = raw.replace(/\./g, "");
  const noDotsAscii = ascii.replace(/\./g, "");

  const noJrRaw = raw.replace(/\s+Jr\.?$/i, "").trim();
  const noJrAscii = ascii.replace(/\s+Jr\.?$/i, "").trim();

  // Also try removing "Jr" in middle patterns like "Acuña Jr."
  const variants = new Set([raw, ascii, noDotsRaw, noDotsAscii, noJrRaw, noJrAscii]);

  return [...variants].map(normSpaces).filter(Boolean);
}

// We "validate" Player/Athlete by directly testing aspect_filter queries.
// This avoids missing names that don't appear in refinement distributions.
async function validatePlayerAthleteMatch({ token, marketplaceId, name, sport }) {
  const q = buildQuery(name, sport);

  for (const cand of candidateAspectValuesForName(name)) {
    const aspectFilter = `Player/Athlete:{${cand}}`;
    const data = await ebayBrowseSearch({
      token,
      marketplaceId,
      q,
      categoryId: CATEGORY_ID,
      limit: 1,
      offset: 0,
      aspectFilter,
    });

    const total = safeNum(data?.total) ?? 0;
    if (total > 0) return { ok: true, aspectValue: cand };

    await sleep(120);
  }

  return { ok: false, aspectValue: null };
}

// If Player/Athlete doesn't match, we allow proceeding ONLY if Sport aspect matches.
async function validateSportMatch({ token, marketplaceId, name, sport }) {
  const q = buildQuery(name, sport);
  const candidates = sportAspectCandidates(sport);

  for (const s of candidates) {
    if (!s) continue;
    const aspectFilter = `Sport:{${s}}`;

    const data = await ebayBrowseSearch({
      token,
      marketplaceId,
      q,
      categoryId: CATEGORY_ID,
      limit: 1,
      offset: 0,
      aspectFilter,
    });

    const total = safeNum(data?.total) ?? 0;
    if (total > 0) return { ok: true, sportAspectValue: s };

    await sleep(120);
  }

  return { ok: false, sportAspectValue: null };
}

// --- computations ---

async function computeAvgActiveListing({
  token,
  marketplaceId,
  name,
  sport,
  aspectMode,
  aspectValue,
  fxRates, // NEW
}) {
  const q = buildQuery(name, sport);

  // aspectMode:
  // - "player" => aspectFilter Player/Athlete:{aspectValue}
  // - "sport"  => aspectFilter Sport:{aspectValue}
  // - null     => no aspect filter
  let aspectFilter = null;
  if (aspectMode === "player" && aspectValue) {
    aspectFilter = `Player/Athlete:{${aspectValue}}`;
  } else if (aspectMode === "sport" && aspectValue) {
    aspectFilter = `Sport:{${aspectValue}}`;
  }

  let offset = 0;

  // We will store CAD-converted prices here
  const pricesCAD = [];

  // Keep some debug info about original currencies and rates used
  let originalCurrency = null;
  let fxRateUsed = null;

  while (offset < LISTING_PAGE_LIMIT) {
    const data = await ebayBrowseSearch({
      token,
      marketplaceId,
      q,
      categoryId: CATEGORY_ID,
      limit: PAGE_SIZE,
      offset,
      aspectFilter,
    });

    const items = data?.itemSummaries || [];

    for (const it of items) {
      const p = it?.price;
      const v = safeNum(p?.value);
      if (v == null) continue;

      const cur = p?.currency || null;
      originalCurrency = originalCurrency || cur;

      const { cad, rateUsed } = convertToCAD(v, cur, fxRates);
      if (cad == null) continue;

      pricesCAD.push(cad);
      fxRateUsed = fxRateUsed || rateUsed;
    }

    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(120);
  }

  return {
    // avgListing is now CAD-normalized
    avgListing: avg(pricesCAD),
    nListing: pricesCAD.length,

    // currency is always CAD for normalized values
    currency: "CAD",

    // extra debug fields (optional but helpful)
    originalCurrency: originalCurrency || null,
    fxRateUsed: fxRateUsed || null,
  };
}

// --- data loading ---
function loadAthletes() {
  if (!fs.existsSync(ATHLETES_PATH)) {
    throw new Error(
      `Missing ${ATHLETES_PATH}. Create data/athletes.json with [{name,sport}, ...] or adjust script.`
    );
  }

  const raw = fs.readFileSync(ATHLETES_PATH, "utf8");
  const arr = JSON.parse(raw);

  // Normalize to { name, sport } (keep sport as given in your file; we map internally)
  return (arr || [])
    .map((x) => ({
      name: normSpaces(x?.name),
      sport: normSpaces(x?.sport),
    }))
    .filter((x) => x.name);
}

// --- main ---
async function main() {
  const token = await getAppToken();

  // NEW: fetch FX once (CAD per 1 unit foreign currency)
  const fx = await getFxRatesToCAD();

  const athletes = loadAthletes();

  // Output is a flat map keyed by athlete name for easy frontend lookup.
  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      minSampleSize: MIN_EBAY_SAMPLE_SIZE,
      marketplaces: MARKETPLACES,
      categoryId: CATEGORY_ID,
      note: "Active listing averages only (Browse API FIXED_PRICE). No sold data. Prices normalized to CAD.",
      fx: {
        source: "CBSA Exchange Rates API",
        asOf: fx.asOf,
        // Keep just the common ones for transparency (you can store all if you want)
        ratesToCAD: {
          CAD: 1,
          USD: fx.rates?.USD ?? null,
          EUR: fx.rates?.EUR ?? null,
        },
      },
    },
  };

  for (let i = 0; i < athletes.length; i++) {
    const { name, sport } = athletes[i];
    console.log(`[${i + 1}/${athletes.length}] ${name} (${sport || "Unknown"})`);

    // 1) Try Player/Athlete validation (CA first, then US)
    let match = null;

    for (const marketplaceId of ["EBAY_CA", "EBAY_US"]) {
      const v = await validatePlayerAthleteMatch({ token, marketplaceId, name, sport });
      if (v.ok) {
        match = { mode: "player", value: v.aspectValue, validatedOn: marketplaceId };
        break;
      }
    }

    // 2) If no Player/Athlete match, require Sport aspect match
    if (!match) {
      for (const marketplaceId of ["EBAY_CA", "EBAY_US"]) {
        const s = await validateSportMatch({ token, marketplaceId, name, sport });
        if (s.ok) {
          match = { mode: "sport", value: s.sportAspectValue, validatedOn: marketplaceId };
          break;
        }
      }
    }

    // 3) If neither matched => skip (avoid fake)
    if (!match) {
      console.log(`${name}: SKIPPED (no Player/Athlete match AND sport did not match)`);
      continue;
    }

    // Compute for marketplaces using the chosen match mode/value
    const rec = {
      match,
      marketplaces: {},
      avg: null,
      n: 0,
      avgListing: null,
      nListing: 0,
      currency: "CAD", // NEW: rollup is CAD
    };

    for (const marketplaceId of MARKETPLACES) {
      try {
        const listing = await computeAvgActiveListing({
          token,
          marketplaceId,
          name,
          sport,
          aspectMode: match.mode,
          aspectValue: match.value,
          fxRates: fx.rates, // NEW
        });

        rec.marketplaces[marketplaceId] = {
          aspectMode: match.mode,
          aspectValue: match.value,

          // CAD-normalized
          avgListing: listing.avgListing,
          nListing: listing.nListing,
          currency: listing.currency, // "CAD"

          // debug fields
          originalCurrency: listing.originalCurrency,
          fxRateUsed: listing.fxRateUsed,
        };
      } catch (e) {
        console.log(`${name} (${marketplaceId}): ERROR ${e?.message || e}`);
        // keep going; partial results are ok
      }
    }

    // Pick a convenience rollup for frontend:
    // Prefer EBAY_CA if it has data, else fallback to US, else others.
    const ca = rec.marketplaces.EBAY_CA;
    const us = rec.marketplaces.EBAY_US;
    const es = rec.marketplaces.EBAY_ES;

    const pick =
      (ca && ca.avgListing != null ? ca : null) ||
      (us && us.avgListing != null ? us : null) ||
      (es && es.avgListing != null ? es : null) ||
      ca ||
      us ||
      es;

    rec.avgListing = pick?.avgListing ?? null;
    rec.nListing = pick?.nListing ?? 0;
    rec.currency = "CAD";

    // Backward-compatible fields (so your UI can read rec.avg / rec.n)
    rec.avg = rec.avgListing;
    rec.n = rec.nListing;

    out[name] = rec;

    // Small delay to be polite
    await sleep(120);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
