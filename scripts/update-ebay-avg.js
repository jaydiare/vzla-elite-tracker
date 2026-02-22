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
// - Converts listing prices to CAD using CBSA Exchange Rates API.
// - NEW: Robust 429 retry/backoff + optional match cache.

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

// NEW: cache validated matches to avoid re-validating every run
const MATCH_CACHE_PATH = path.join(__dirname, "..", "data", "ebay-match-cache.json");

// Category you were using (Trading Card Singles)
const CATEGORY_ID = "261328";

// Listing sampling
const LISTING_PAGE_LIMIT = 100; // max active listings to average per marketplace
const PAGE_SIZE = 60;

// Your UI threshold
const MIN_EBAY_SAMPLE_SIZE = 8;

// Marketplaces to compute
const MARKETPLACES = ["EBAY_US", "EBAY_CA", "EBAY_ES"];

// NEW: pick ONE marketplace to validate on (dramatically reduces calls)
const VALIDATE_ON_MARKETPLACE = "EBAY_US";

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

// --- NEW: retry/backoff wrapper (handles 429) ---
async function fetchWithRetry(url, options, { maxRetries = 6 } = {}) {
  let attempt = 0;

  while (true) {
    const res = await fetch(url, options);

    if (res.status !== 429) return res;

    attempt++;
    if (attempt > maxRetries) return res;

    // Prefer Retry-After header if provided
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30000, 1000 * Math.pow(2, attempt)); // 2s,4s,8s,... capped at 30s

    const bodyTxt = await res.text().catch(() => "");
    console.warn(`429 rate limit. Attempt ${attempt}/${maxRetries}. Waiting ${waitMs}ms. ${bodyTxt ? "Body:" : ""} ${bodyTxt}`);

    await sleep(waitMs);
  }
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
    url.searchParams.set("aspect_filter", aspectFilter);
  }

  const res = await fetchWithRetry(url.toString(), {
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

// Validate Player/Athlete by directly testing aspect_filter queries.
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

    // IMPORTANT: slow down (was 120ms)
    await sleep(650);
  }

  return { ok: false, aspectValue: null };
}

// If Player/Athlete doesn't match, allow proceeding ONLY if Sport aspect matches.
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

    await sleep(650);
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

  let aspectFilter = null;
  if (aspectMode === "player" && aspectValue) {
    aspectFilter = `Player/Athlete:{${aspectValue}}`;
  } else if (aspectMode === "sport" && aspectValue) {
    aspectFilter = `Sport:{${aspectValue}}`;
  }

  let offset = 0;
  const pricesCAD = [];

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

    // IMPORTANT: slow down between pages too
    await sleep(650);
  }

  return {
    avgListing: avg(pricesCAD),
    nListing: pricesCAD.length,
    currency: "CAD",
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

function loadMatchCache() {
  try {
    if (!fs.existsSync(MATCH_CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(MATCH_CACHE_PATH, "utf8")) || {};
  } catch {
    return {};
  }
}

function saveMatchCache(cache) {
  fs.mkdirSync(path.dirname(MATCH_CACHE_PATH), { recursive: true });
  fs.writeFileSync(MATCH_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// --- main ---
async function main() {
  const token = await getAppToken();
  const fx = await getFxRatesToCAD();
  const athletes = loadAthletes();

  const matchCache = loadMatchCache();

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

    // 0) Cache hit?
    let match = matchCache[name] || null;

    // 1) Validate once on ONE marketplace (default EBAY_US)
    if (!match) {
      const marketplaceId = VALIDATE_ON_MARKETPLACE;

      const v = await validatePlayerAthleteMatch({ token, marketplaceId, name, sport });
      if (v.ok) {
        match = { mode: "player", value: v.aspectValue, validatedOn: marketplaceId };
      } else {
        const s = await validateSportMatch({ token, marketplaceId, name, sport });
        if (s.ok) {
          match = { mode: "sport", value: s.sportAspectValue, validatedOn: marketplaceId };
        }
      }

      if (match) {
        matchCache[name] = match;
        saveMatchCache(matchCache);
      }
    }

    // 2) If neither matched => skip
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
      nListing: 0,
      currency: "CAD",
    };

    // 3) Compute for marketplaces using validated match
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
          avgListing: listing.avgListing,
          nListing: listing.nListing,
          currency: listing.currency,
          originalCurrency: listing.originalCurrency,
          fxRateUsed: listing.fxRateUsed,
        };
      } catch (e) {
        console.log(`${name} (${marketplaceId}): ERROR ${e?.message || e}`);
      }

      // slow down between marketplaces
      await sleep(650);
    }

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

    rec.avg = rec.avgListing;
    rec.n = rec.nListing;

    out[name] = rec;

    // polite delay between athletes
    await sleep(900);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
