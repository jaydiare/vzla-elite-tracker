// scripts/update-ebay-sold-median.js
// Node 20+ (uses global fetch)
//
// Pulls SOLD listing comps via Apify actor caffein.dev/ebay-sold-listings
// Filters to Topps/Panini only, includes graded cards
// Computes MEDIAN sold price (USD) using totalPrice when available
//
// Env:
//   APIFY_TOKEN
//
// Input:
//   data/athletes.json: [{ name, sport, ... }]
//
// Output:
//   data/ebay-sold-median.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APIFY_TOKEN = process.env.APIFY_TOKEN;
if (!APIFY_TOKEN) {
  console.error("Missing APIFY_TOKEN in env.");
  process.exit(1);
}

const ATHLETES_PATH = path.join(__dirname, "..", "data", "athletes.json");
const OUT_PATH = path.join(__dirname, "..", "data", "ebay-sold-median.json");

// Apify actor you linked
const ACTOR_ID = "caffein.dev~ebay-sold-listings";

// Per your request
const RESULTS_LIMIT = 60;
const MIN_SAMPLE_SIZE = 5;

// Brand filter
const BRANDS = ["topps", "panini"];

// --- helpers ---
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function norm(s) {
  return String(s || "").toLowerCase().trim();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Filter out junk sold results that are not single-card comps
function isJunkSoldCompTitle(title) {
  const t = norm(title);

  const badPhrases = [
    "you pick",
    "you choose",
    "pick your",
    "choose your",
    "your choice",
    "complete your set",
    "complete set",
    "set builder",
    "set break",
    "base singles",
    "insert singles",
    "singles you pick",
    "you pick!",
    "you pick -",
    "lot",
    "team lot",
    "player lot",
    "break",
    "case break",
    "random",
    "bulk",
    "paper rc's & vets",
    "rc's & vets",
  ];

  return badPhrases.some((p) => t.includes(p));
}

// Keep only Topps or Panini (case-insensitive)
function hasAllowedBrand(title) {
  const t = norm(title);
  return BRANDS.some((b) => t.includes(b));
}

// Light relevance check so “Topps singles” doesn’t match wrong player
// We require last name to appear in title.
function titleLooksRelevantToPlayer(title, playerName) {
  const t = norm(title);
  const name = norm(playerName);
  const parts = name.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return true;
  return t.includes(last);
}

// --- FX (Normalize ANY currency -> USD) ---
// CBSA Exchange Rates API (rates are CAD per 1 unit of foreign currency)
const CBSA_FX_URL =
  "https://bcd-api-dca-ipa.cbsa-asfc.cloud-nuage.canada.ca/exchange-rate-lambda/exchange-rates";

// Returns rates as "USD per 1 unit of currency": { USD:1, CAD:<>, EUR:<>, ... }
async function getFxRatesToUSD() {
  const res = await fetch(CBSA_FX_URL, { headers: { "Content-Type": "application/json" } });

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
  if (!Number.isFinite(amount) || amount <= 0) return { usd: null, rateUsed: null };

  const rate = fxRatesToUSD?.[cur];
  if (!Number.isFinite(rate) || rate <= 0) return { usd: null, rateUsed: null };

  return { usd: amount * rate, rateUsed: rate };
}

// Prefer totalPrice if present, else sold+shipping, else sold
function getTotalPrice(item) {
  // Your actor output includes: soldPrice/soldCurrency, shippingPrice/shippingCurrency, totalPrice
  // totalCurrency not shown; assume soldCurrency for totalPrice.
  const soldCur = item?.soldCurrency || item?.shippingCurrency || null;

  const total = safeNum(item?.totalPrice);
  if (total != null && total > 0) return { amount: total, currency: soldCur, mode: "totalPrice" };

  const sold = safeNum(item?.soldPrice);
  const ship = safeNum(item?.shippingPrice);

  if (sold != null && sold > 0 && ship != null && ship >= 0) {
    return { amount: sold + ship, currency: soldCur, mode: "sold+shipping" };
  }

  if (sold != null && sold > 0) return { amount: sold, currency: soldCur, mode: "soldOnly" };

  return { amount: null, currency: null, mode: null };
}

// --- Apify call ---
async function runApifyActorAndGetItems(input) {
  // “run-sync-get-dataset-items” returns dataset items directly
  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Apify actor failed (${res.status}): ${txt}`);
  }

  return res.json();
}

// --- data loading ---
function loadAthletes() {
  if (!fs.existsSync(ATHLETES_PATH)) {
    throw new Error(`Missing ${ATHLETES_PATH}. Create data/athletes.json with [{name,sport}, ...].`);
  }

  const raw = fs.readFileSync(ATHLETES_PATH, "utf8");
  const arr = JSON.parse(raw);

  return (arr || [])
    .map((x) => ({ name: normSpaces(x?.name), sport: normSpaces(x?.sport) }))
    .filter((x) => x.name);
}

function buildKeyword(name, sport) {
  // Keep broad; brand filter is applied after scraping (Topps/Panini)
  const sportHint = sport ? ` ${sport}` : "";
  return `${name}${sportHint} card`;
}

// --- main ---
async function main() {
  const athletes = loadAthletes();

  const fx = await getFxRatesToUSD();

  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      source: "Apify Actor caffein.dev/ebay-sold-listings",
      note: "SOLD comps filtered to Topps/Panini; junk titles removed; median based on totalPrice when available; currency normalized to USD via CBSA.",
      resultsLimit: RESULTS_LIMIT,
      minSampleSize: MIN_SAMPLE_SIZE,
      brands: BRANDS,
      fx: { source: "CBSA Exchange Rates API", asOf: fx.asOf },
    },
  };

  for (let i = 0; i < athletes.length; i++) {
    const { name, sport } = athletes[i];
    console.log(`[${i + 1}/${athletes.length}] ${name}`);

    const keyword = buildKeyword(name, sport);

    // Actor input fields can vary; these are common patterns.
    // If the actor uses different field names, we’ll adjust quickly after one run.
    const input = {
      keyword,
      maxItems: RESULTS_LIMIT,
      limit: RESULTS_LIMIT,
    };

    try {
      const items = await runApifyActorAndGetItems(input);

      const pricesUSD = [];
      let firstCur = null;

      for (const it of items || []) {
        const title = it?.title || "";
        if (!title) continue;

        // 1) Filter: Topps/Panini only
        if (!hasAllowedBrand(title)) continue;

        // 2) Filter: remove “you pick / lots / breaks”
        if (isJunkSoldCompTitle(title)) continue;

        // 3) Sanity: last name appears
        if (!titleLooksRelevantToPlayer(title, name)) continue;

        // 4) Price: prefer totalPrice
        const { amount, currency } = getTotalPrice(it);
        if (amount == null) continue;

        firstCur = firstCur || currency || null;

        // Normalize currency to USD
        const { usd } = convertToUSD(amount, currency, fx.rates);
        if (usd == null) continue;

        pricesUSD.push(usd);
      }

      const med = pricesUSD.length ? median(pricesUSD) : null;

      out[name] = {
        keyword,
        nSoldUsed: pricesUSD.length,
        medianSoldUSD: pricesUSD.length >= MIN_SAMPLE_SIZE ? med : null,
        currency: "USD",
        // helpful debug info (safe for frontend if you want)
        sourceCurrencyExample: firstCur,
      };
    } catch (e) {
      console.log(`${name}: ERROR ${e?.message || e}`);
      out[name] = {
        keyword,
        nSoldUsed: 0,
        medianSoldUSD: null,
        currency: "USD",
        error: String(e?.message || e),
      };
    }

    // Avoid bursts (Apify + eBay scraping)
    await sleep(300);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
