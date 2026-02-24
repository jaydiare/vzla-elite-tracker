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
// - Normalizes listing prices to USD using CBSA Exchange Rates API as a base.
// - Adds Manufacturer aspect filter to focus on major sports card makers.
// - Uses TAGUCHI trimmed mean (winsorized mean, 10%) for listing prices.
// - Adds market stability CV (Coefficient of Variation) on the SAME winsorized sample:
//        CV = s / mean  (lower CV => more stable)
//
// NEW (this change):
// - Ungraded listings must be Card Condition: Near Mint or Better OR Excellent only
// - Excludes damaged/low-condition ungraded listings using descriptors if present,
//   otherwise falls back to title-based detection.

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

// restrict to major manufacturers (sports card makers)
const MANUFACTURERS = ["Topps", "Panini", "Upper Deck", "Leaf", "Topps NOW"];

// Taguchi caps
const TAGUCHI_TRIM_PCT = 0.4;

// --------------------
// ✅ NEW: UNGRADED condition policy
// --------------------
const UNGRADED_ALLOWED_CONDITIONS = [
  "near mint or better",
  "near-mint or better",
  "near mint",
  "nm",
  "nm-mt",
  "nmt",
  "excellent",
  "ex",
];

// if any of these appear (descriptor/title), reject ungraded listing
const UNGRADED_BLOCKLIST = [
  "damaged",
  "damage",
  "poor",
  "fair",
  "very good",
  "vg",
  "good",
  "gd",
  "creases",
  "crease",
  "wrinkle",
  "wrinkling",
  "corner wear",
  "surface wear",
  "paper loss",
  "stain",
  "stained",
  "water damage",
  "tape",
  "writing",
  "marked",
  "marked up",
  "pin hole",
  "hole",
  "torn",
  "tear",
  "scratches",
  "scratch",
];

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
      .replace(/[.'’"]/g, "")
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

// Sample standard deviation
function stdev(values) {
  if (!values || values.length < 2) return null;
  const m = avg(values);
  if (m == null) return null;
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  const varSample = s / (values.length - 1);
  const sd = Math.sqrt(varSample);
  return Number.isFinite(sd) ? sd : null;
}

// Taguchi "trimmed mean" (winsorized mean).
function taguchiTrimmedMean(values, trimPercent = TAGUCHI_TRIM_PCT) {
  if (!values || !values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const k = Math.floor(n * trimPercent);

  if (n < 3 || k === 0) return median(sorted);
  if (n <= 2 * k) return median(sorted);

  const lowCap = sorted[k];
  const highCap = sorted[n - k - 1];

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = sorted[i];
    sum += v < lowCap ? lowCap : v > highCap ? highCap : v;
  }
  return sum / n;
}

function taguchiWinsorizedSample(values, trimPercent = TAGUCHI_TRIM_PCT) {
  if (!values || !values.length) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const k = Math.floor(n * trimPercent);

  if (n < 3 || k === 0 || n <= 2 * k) return sorted;

  const lowCap = sorted[k];
  const highCap = sorted[n - k - 1];

  return sorted.map((v) => (v < lowCap ? lowCap : v > highCap ? highCap : v));
}

function taguchiCV(values, trimPercent = TAGUCHI_TRIM_PCT) {
  if (!values || values.length < 3) return null;

  const wins = taguchiWinsorizedSample(values, trimPercent);
  if (!wins || wins.length < 3) return null;

  const m = avg(wins);
  const sd = stdev(wins);

  if (m == null || sd == null) return null;
  if (!Number.isFinite(m) || !Number.isFinite(sd)) return null;
  if (m <= 0) return null;

  return sd / m;
}

// ✅ NEW: string utilities for ungraded condition policy
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text, arr) {
  const t = normText(text);
  return arr.some((w) => t.includes(normText(w)));
}

// Try to read condition descriptor names from multiple possible shapes.
// (eBay responses differ across endpoints; this is defensive.)
function extractConditionDescriptorTexts(item) {
  const out = [];

  // Possible: item.conditionDescriptors: [{ name }, { descriptorName }, ...]
  const cds = item?.conditionDescriptors;
  if (Array.isArray(cds)) {
    for (const d of cds) {
      if (!d) continue;
      out.push(d?.name);
      out.push(d?.descriptorName);
      out.push(d?.value);
      out.push(d?.valueName);
    }
  }

  // Possible: item.conditionDescriptorValues or similar
  const cdv = item?.conditionDescriptorValues;
  if (Array.isArray(cdv)) {
    for (const d of cdv) {
      if (!d) continue;
      out.push(d?.name);
      out.push(d?.descriptorName);
      out.push(d?.value);
      out.push(d?.valueName);
    }
  }

  return out.filter(Boolean).map(normText);
}

// ✅ NEW: decide if listing should be included when it's UNGRADED
function ungradedPassesConditionPolicy(item) {
  const title = normText(item?.title || "");
  const cond = normText(item?.condition || "");
  const descs = extractConditionDescriptorTexts(item);

  // hard reject if any blocked terms appear in descriptor/title/condition
  const joined = [title, cond, ...descs].join(" | ");
  if (includesAny(joined, UNGRADED_BLOCKLIST)) return false;

  // accept if allowed condition appears in descriptor/condition/title
  if (includesAny(joined, UNGRADED_ALLOWED_CONDITIONS)) return true;

  // If we can't detect condition clearly, reject (better to be strict than include damaged)
  return false;
}

// --------------------
// NOTE: You said you're already filtering graded vs not graded.
// Here we only plug in the stricter condition rule *for ungraded*
// without changing your graded logic.
// --------------------
function isGradedListing(item) {
  // Keep this simple & compatible:
  // - if your existing code already detects graded, you can replace this with your method.
  const cond = normText(item?.condition || "");
  const title = normText(item?.title || "");

  if (cond.includes("graded")) return true;

  // common grading keywords as fallback (won't block ungraded rule because it only runs when false)
  const graderHints = ["psa", "bgs", "sgc", "cgc", "beckett", "gem mint", "gm mt", "10", "9.5"];
  return graderHints.some((k) => title.includes(k));
}

function getHeaderMarketplace(marketplaceId) {
  return { "X-EBAY-C-MARKETPLACE-ID": marketplaceId };
}

// Build a search query.
function buildQuery(name, sport) {
  const sportHint = sport ? ` ${sport}` : "";
  return `${name}${sportHint} card`;
}

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

function buildAspectFilter({ aspectMode, aspectValue }) {
  const parts = [];

  if (aspectMode === "player" && aspectValue) {
    parts.push(`Player/Athlete:{${aspectValue}}`);
  } else if (aspectMode === "sport" && aspectValue) {
    parts.push(`Sport:{${aspectValue}}`);
  }

  const mfg = (MANUFACTURERS || []).filter(Boolean);
  if (mfg.length) {
    parts.push(`Manufacturer:{${mfg.join("|")}}`);
  }

  return parts.length ? parts.join(",") : null;
}

// --- FX (Normalize ANY currency -> USD) ---
const CBSA_FX_URL =
  "https://bcd-api-dca-ipa.cbsa-asfc.cloud-nuage.canada.ca/exchange-rate-lambda/exchange-rates";

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

  const usdPer = { USD: 1 };

  for (const [cur, cadPerCur] of Object.entries(cadPer)) {
    if (!Number.isFinite(cadPerCur) || cadPerCur <= 0) continue;
    usdPer[cur] = cadPerCur / cadPerUsd;
  }

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

  url.searchParams.append("filter", "buyingOptions:{FIXED_PRICE}");

  if (aspectFilter) {
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
      // -----------------------------
      // ✅ NEW: enforce ungraded policy
      // -----------------------------
      const graded = isGradedListing(it);

      // If NOT graded, only allow Near Mint or Better OR Excellent (and block damaged)
      if (!graded) {
        const okUngraded = ungradedPassesConditionPolicy(it);
        if (!okUngraded) continue;
      }

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

  const taguchiListing = taguchiTrimmedMean(pricesUSD, TAGUCHI_TRIM_PCT);
  const marketStabilityCV = taguchiCV(pricesUSD, TAGUCHI_TRIM_PCT);

  return {
    avgListing: taguchiListing,
    taguchiListing,
    marketStabilityCV,
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
      note:
        "Active listing robust mean (Browse API FIXED_PRICE). No sold data. Prices normalized to USD. Includes market stability CV (sd/mean). Ungraded listings restricted to Near Mint or Better / Excellent (damaged excluded).",
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
      listingStat: { method: "taguchi_winsorized_mean", trimPercent: TAGUCHI_TRIM_PCT },
      stabilityStat: {
        method: "cv",
        formula: "sd/mean",
        sample: "winsorized",
        trimPercent: TAGUCHI_TRIM_PCT,
      },
      ungradedPolicy: {
        allow: ["Near Mint or Better", "Excellent"],
        blocklist: "damaged/low-condition keywords",
      },
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
      taguchiListing: null,
      marketStabilityCV: null,
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

          avgListing: listing.avgListing,
          taguchiListing: listing.taguchiListing,
          marketStabilityCV: listing.marketStabilityCV,
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
      (ca && ca.taguchiListing != null ? ca : null) ||
      (us && us.taguchiListing != null ? us : null) ||
      ca ||
      us;

    rec.taguchiListing = pick?.taguchiListing ?? null;
    rec.avgListing = pick?.avgListing ?? null;
    rec.marketStabilityCV = pick?.marketStabilityCV ?? null;
    rec.nListing = pick?.nListing ?? 0;
    rec.currency = "USD";

    rec.avg = rec.avgListing;
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
