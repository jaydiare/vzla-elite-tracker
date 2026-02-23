// scripts/update-ebay-avg.js
// Node 20+ (uses global fetch)
//
// Computes ACTIVE listing price from eBay Browse API:
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
// - NEW: Normalizes listing prices to USD using CBSA Exchange Rates API as a base.
//        (CBSA returns CAD per 1 unit; we convert that to USD-per-currency.)
// - NEW: Adds Manufacturer aspect filter to focus on major sports card makers.
// - NEW: Uses TRIMMED MEAN (10%) for listing prices (robust vs outliers).

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
const LISTING_PAGE_LIMIT = 60; // max active listings to average per marketplace
const PAGE_SIZE = 60;

// Your UI threshold
const MIN_EBAY_SAMPLE_SIZE = 4;

// Marketplaces to compute
const MARKETPLACES = ["EBAY_US", "EBAY_CA"];

// NEW: restrict to major manufacturers (sports card makers)
const MANUFACTURERS = ["Topps", "Panini", "Upper Deck", "Leaf", "Topps NOW"];

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

// median helper (used as a fallback for tiny samples)
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ✅ NEW: trimmed mean helper (default 10% trim)
// If sample too small to trim, fallback to median.
function trimmedMean(values, trimPercent = 0.1) {
  if (!values || !values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * trimPercent);

  if (sorted.length <= trimCount * 2) {
    return median(sorted);
  }

  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  return avg(trimmed);
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

// NEW: build a combined eBay aspect_filter including Manufacturer
function buildAspectFilter({ aspectMode, aspectValue }) {
  const parts = [];

  if (aspectMode === "player" && aspectValue) {
    parts.push(`Player/Athlete:{${aspectValue}}`);
  } else if (aspectMode === "sport" && aspectValue) {
    parts.push(`Sport:{${aspectValue}}`);
  }

  // Always restrict to known card manufacturers (sports card makers)
  const mfg = (MANUFACTURERS || []).filter(Boolean);
  if (mfg.length) {
    parts.push(`Manufacturer:{${mfg.join("|")}}`);
  }

  return parts.length ? parts.join(",") : null;
}

// --- FX (Normalize ANY currency -> USD) ---
// CBSA Exchange Rates API (rates are CAD per 1 unit of foreign currency)
const CBSA_FX_URL =
  "https://bcd-api-dca-ipa.cbsa-asfc.cloud-nuage.canada.ca/exchange-rate-lambda/exchange-rates";

// Returns rates as "USD per 1 unit of currency":
// { USD: 1, CAD: <usd_per_cad>, EUR: <usd_per_eur>, ... }
async function getFxRatesToUSD() {
  const res = await fetch(CBSA_FX_URL, {
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to fetch FX rates (${res.status}): ${txt}`);
  }

  const json = await res.json();
  const rows = json?.ForeignExchangeRates || json?.foreignExchangeRates || [];

  // Build CAD per 1 unit first
  const cadPer = { CAD: 1 };
  let asOf = null;

  for (const r of rows) {
    const from = String(r?.FromCurrency?.Value || r?.FromCurrency || "").toUpperCase();
    const to = String(r?.ToCurrency?.Value || r?.ToCurrency || "").toUpperCase();
    const rate = Number(r?.Rate);

    if (to === "CAD" && Number.isFinite(rate) && rate > 0 && from) {
      cadPer[from] = rate;
      asOf =
        asOf ||
        r?.ExchangeRateEffectiveTimestamp ||
        r?.ValidStartDate ||
        r?.ExchangeRateExpiryTimestamp ||
        null;
    }
  }

  const cadPerUsd = cadPer.USD;
  if (!Number.isFinite(cadPerUsd) || cadPerUsd <= 0) {
    throw new Error("CBSA FX: missing/invalid USD->CAD rate (needed to normalize to USD).");
  }

  // Convert CAD-per to USD-per using:
  // usdPer[cur] = cadPer[cur] / cadPer[USD]
  const usdPer = { USD: 1 };

  for (const [cur, cadPerCur] of Object.entries(cadPer)) {
    if (!Number.isFinite(cadPerCur) || cadPerCur <= 0) continue;
    usdPer[cur] = cadPerCur / cadPerUsd;
  }

  // CAD -> USD specifically
  usdPer.CAD = 1 / cadPerUsd;

  return { rates: usdPer, asOf };
}

function convertToUSD(amount, currency, fxRatesToUSD) {
  const cur = String(currency || "").toUpperCase();
  if (!Number.isFinite(amount)) return { usd: null, rateUsed: null };

  const rate = fxRatesToUSD?.[cur];
  if (!Number.isFinite(rate) || rate <= 0) return { usd: null, rateUsed: null };

  return { usd: amount * rate, rateUsed: rate };
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
    // aspect_filter format: "Player/Athlete:{Jose Altuve},Manufacturer:{Topps|Panini|Upper Deck}"
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
  const raw = normSpaces(name);

  const ascii = normSpaces(stripDiacritics(raw));
  const noDotsRaw = raw.replace(/\./g, "");
  const noDotsAscii = ascii.replace(/\./g, "");

  const noJrRaw = raw.replace(/\s+Jr\.?$/i, "").trim();
  const noJrAscii = ascii.replace(/\s+Jr\.?$/i, "").trim();

  const variants = new Set([raw, ascii, noDotsRaw, noDotsAscii, noJrRaw, noJrAscii]);

  return [...variants].map(normSpaces).filter(Boolean);
}

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
  fxRates,
}) {
  const q = buildQuery(name, sport);
  const aspectFilter = buildAspectFilter({ aspectMode, aspectValue });

  let offset = 0;
  const pricesUSD = [];

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

      const { usd, rateUsed } = convertToUSD(v, cur, fxRates);
      if (usd == null) continue;

      pricesUSD.push(usd);
      fxRateUsed = fxRateUsed || rateUsed;
    }

    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(120);
  }

  // ✅ CHANGE: use TRIMMED MEAN instead of median
  const trimmedListing = trimmedMean(pricesUSD, 0.1); // 10% trim

  return {
    // keep field names stable for your frontend: avgListing now represents trimmed mean
    avgListing: trimmedListing,
    trimmedListing, // explicit
    nListing: pricesUSD.length,
    currency: "USD",
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
  const fx = await getFxRatesToUSD();
  const athletes = loadAthletes();

  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      minSampleSize: MIN_EBAY_SAMPLE_SIZE,
      marketplaces: MARKETPLACES,
      categoryId: CATEGORY_ID,
      note: "Active listing TRIMMED MEAN (10%) (Browse API FIXED_PRICE). No sold data. Prices normalized to USD.",
      fx: {
        source: "CBSA Exchange Rates API",
        asOf: fx.asOf,
        ratesToUSD: {
          USD: 1,
          CAD: fx.rates?.CAD ?? null,
          EUR: fx.rates?.EUR ?? null,
        },
      },
      manufacturers: MANUFACTURERS,
      listingStat: { method: "trimmed_mean", trimPercent: 0.1 },
    },
  };

  for (let i = 0; i < athletes.length; i++) {
    const { name, sport } = athletes[i];
    console.log(`[${i + 1}/${athletes.length}] ${name} (${sport || "Unknown"})`);

    let match = null;

    for (const marketplaceId of ["EBAY_CA", "EBAY_US"]) {
      const v = await validatePlayerAthleteMatch({ token, marketplaceId, name, sport });
      if (v.ok) {
        match = { mode: "player", value: v.aspectValue, validatedOn: marketplaceId };
        break;
      }
    }

    if (!match) {
      for (const marketplaceId of ["EBAY_CA", "EBAY_US"]) {
        const s = await validateSportMatch({ token, marketplaceId, name, sport });
        if (s.ok) {
          match = { mode: "sport", value: s.sportAspectValue, validatedOn: marketplaceId };
          break;
        }
      }
    }

    if (!match) {
      console.log(`${name}: SKIPPED (no Player/Athlete match AND sport did not match)`);
      continue;
    }

    const rec = {
      match,
      marketplaces: {},
      avg: null,
      n: 0,
      avgListing: null,
      trimmedListing: null,
      nListing: 0,
      currency: "USD",
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
          fxRates: fx.rates,
        });

        rec.marketplaces[marketplaceId] = {
          aspectMode: match.mode,
          aspectValue: match.value,

          // USD-normalized (avgListing now trimmed mean)
          avgListing: listing.avgListing,
          trimmedListing: listing.trimmedListing,
          nListing: listing.nListing,
          currency: listing.currency,

          originalCurrency: listing.originalCurrency,
          fxRateUsed: listing.fxRateUsed,
        };
      } catch (e) {
        console.log(`${name} (${marketplaceId}): ERROR ${e?.message || e}`);
      }
    }

    const ca = rec.marketplaces.EBAY_CA;
    const us = rec.marketplaces.EBAY_US;

    const pick =
      (ca && ca.trimmedListing != null ? ca : null) ||
      (us && us.trimmedListing != null ? us : null) ||
      ca ||
      us;

    rec.trimmedListing = pick?.trimmedListing ?? null;
    rec.avgListing = pick?.avgListing ?? null; // same value (trimmed mean)
    rec.nListing = pick?.nListing ?? 0;
    rec.currency = "USD";

    // Backward-compatible fields (so your UI can read rec.avg / rec.n)
    rec.avg = rec.avgListing; // now trimmed mean
    rec.n = rec.nListing;

    out[name] = rec;

    await sleep(500);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
