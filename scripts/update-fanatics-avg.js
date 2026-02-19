// scripts/update-fanatics-avg.js
// Node 20+ (uses global fetch)
//
// Builds an "avg active price" file for Fanatics by:
// 1) discovering product URLs from a search/listing page
// 2) scraping those product URLs via Apify actor
// 3) averaging the returned price field(s)
//
// Env vars required:
//   APIFY_TOKEN
//
// Optional env vars:
//   APIFY_ACTOR_ID (default: fortuitous_pirate/fanatics-scraper)
//   FANATICS_SEARCH_URL_TEMPLATE (example below)
//   FANATICS_PRODUCT_URL_REGEX  (example below)
//   FANATICS_MAX_PRODUCTS_PER_ATHLETE (default 30)
//   FANATICS_MIN_SAMPLE_SIZE (default 5)
//
// Output:
//   data/fanatics-avg.json

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

// Actor from your screenshot (can override)
const APIFY_ACTOR_ID = process.env.APIFY_ACTOR_ID || "fortuitous_pirate/fanatics-scraper";

// You MUST set this to Fanatics Collect (or Fanatics) search URL template you want to use.
// Example (you will replace domain/path to match your target site):
//   https://www.fanaticscollect.com/search?q={QUERY}
//   https://www.fanatics.com/search/{QUERY}
// Use {QUERY} placeholder (will be URL-encoded).
const FANATICS_SEARCH_URL_TEMPLATE =
  process.env.FANATICS_SEARCH_URL_TEMPLATE || "";

// Regex used to extract product URLs from the search HTML.
// Provide as a JS regex string WITHOUT the surrounding slashes.
// Example patterns you might use (you must confirm on your site):
//   href="(https?:\/\/www\.fanaticscollect\.com\/[^"]+)"
//   href="(\/product\/[^"]+)"
//   href="(\/p-\d+\/[^"]+)"
const FANATICS_PRODUCT_URL_REGEX =
  process.env.FANATICS_PRODUCT_URL_REGEX || "";

// Limits
const MAX_PRODUCTS_PER_ATHLETE = Number(process.env.FANATICS_MAX_PRODUCTS_PER_ATHLETE || 30);
const MIN_SAMPLE_SIZE = Number(process.env.FANATICS_MIN_SAMPLE_SIZE || 5);

// Paths
const ATHLETES_PATH = path.join(__dirname, "..", "data", "athletes.json");
const OUT_PATH = path.join(__dirname, "..", "data", "fanatics-avg.json");

// Helpers
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeNum(x) {
  if (x == null) return null;
  const n = Number(
    typeof x === "string" ? x.replace(/[^0-9.]/g, "") : x
  );
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  if (!values.length) return null;
  const s = values.reduce((a, b) => a + b, 0);
  return s / values.length;
}

function loadAthletes() {
  if (!fs.existsSync(ATHLETES_PATH)) {
    throw new Error(
      `Missing ${ATHLETES_PATH}. Create data/athletes.json with [{name,sport}, ...].`
    );
  }
  const raw = fs.readFileSync(ATHLETES_PATH, "utf8");
  const arr = JSON.parse(raw);
  return (arr || [])
    .map((x) => ({ name: normSpaces(x?.name), sport: normSpaces(x?.sport) }))
    .filter((x) => x.name);
}

// --- Step 1: Discover product URLs from search page HTML ---
async function discoverProductUrls({ athleteName, sport }) {
  if (!FANATICS_SEARCH_URL_TEMPLATE) {
    throw new Error(
      "Missing FANATICS_SEARCH_URL_TEMPLATE env var. Example: https://www.fanaticscollect.com/search?q={QUERY}"
    );
  }
  if (!FANATICS_PRODUCT_URL_REGEX) {
    throw new Error(
      "Missing FANATICS_PRODUCT_URL_REGEX env var. Example: href=\"(\\/product\\/[^\\\"]+)\""
    );
  }

  const query = encodeURIComponent(`${athleteName} ${sport || ""} card`.trim());
  const searchUrl = FANATICS_SEARCH_URL_TEMPLATE.replace("{QUERY}", query);

  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; VZLAEliteBot/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Search page fetch failed (${res.status}): ${txt.slice(0, 200)}`);
  }

  const html = await res.text();

  const re = new RegExp(FANATICS_PRODUCT_URL_REGEX, "g");
  const found = new Set();

  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (!url) continue;
    found.add(url);
    if (found.size >= MAX_PRODUCTS_PER_ATHLETE) break;
  }

  // Normalize relative URLs if needed
  const urls = [...found].map((u) => {
    if (u.startsWith("http://") || u.startsWith("https://")) return u;

    // derive origin from searchUrl
    const origin = new URL(searchUrl).origin;
    return new URL(u, origin).toString();
  });

  return urls.slice(0, MAX_PRODUCTS_PER_ATHLETE);
}

// --- Step 2: Call Apify actor with product URLs ---
async function runApifyActor({ productUrls }) {
  // Apify Actor API: POST https://api.apify.com/v2/acts/{actorId}/runs?token=...
  // Then wait for run to finish, and read dataset items.

  const startUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(
    APIFY_ACTOR_ID
  )}/runs?token=${encodeURIComponent(APIFY_TOKEN)}&waitForFinish=1200`;

  const input = {
    productUrls,
    maxTotalItems: productUrls.length,
  };

  const runRes = await fetch(startUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!runRes.ok) {
    const txt = await runRes.text().catch(() => "");
    throw new Error(`Apify actor run failed (${runRes.status}): ${txt}`);
  }

  const runJson = await runRes.json();
  const run = runJson?.data;
  const datasetId = run?.defaultDatasetId;
  if (!datasetId) {
    throw new Error("No defaultDatasetId returned from Apify run.");
  }

  // Fetch dataset items
  const itemsUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(
    APIFY_TOKEN
  )}&clean=true`;

  const itemsRes = await fetch(itemsUrl);
  if (!itemsRes.ok) {
    const txt = await itemsRes.text().catch(() => "");
    throw new Error(`Apify dataset fetch failed (${itemsRes.status}): ${txt}`);
  }

  return itemsRes.json();
}

// --- Extract price from actor output ---
// Different actors return different shapes. This tries multiple common fields.
function extractPriceAndCurrency(item) {
  // Common patterns: item.price.value / item.price / item.currentPrice / item.salePrice
  const candidates = [
    item?.price?.value,
    item?.price,
    item?.currentPrice?.value,
    item?.currentPrice,
    item?.salePrice?.value,
    item?.salePrice,
    item?.listingPrice?.value,
    item?.listingPrice,
  ];

  let price = null;
  for (const c of candidates) {
    const n = safeNum(c);
    if (n != null) {
      price = n;
      break;
    }
  }

  const currency =
    item?.price?.currency ||
    item?.currentPrice?.currency ||
    item?.salePrice?.currency ||
    item?.listingPrice?.currency ||
    item?.currency ||
    null;

  return { price, currency };
}

// --- main ---
async function main() {
  const athletes = loadAthletes();

  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      minSampleSize: MIN_SAMPLE_SIZE,
      actorId: APIFY_ACTOR_ID,
      maxProductsPerAthlete: MAX_PRODUCTS_PER_ATHLETE,
      note:
        "Averages computed from product URLs discovered via search HTML + Apify actor output. Ensure search template + regex match your target site.",
    },
  };

  for (let i = 0; i < athletes.length; i++) {
    const { name, sport } = athletes[i];
    console.log(`[${i + 1}/${athletes.length}] ${name} (${sport || "Unknown"})`);

    try {
      // 1) Discover product URLs
      const productUrls = await discoverProductUrls({ athleteName: name, sport });

      if (!productUrls.length) {
        console.log(`  -> No product URLs found. Skipping.`);
        continue;
      }

      // 2) Scrape product URLs with Apify
      const items = await runApifyActor({ productUrls });

      const prices = [];
      let currency = null;

      for (const it of items || []) {
        const { price, currency: cur } = extractPriceAndCurrency(it);
        if (price == null) continue;
        prices.push(price);
        currency = currency || cur;
      }

      if (prices.length < MIN_SAMPLE_SIZE) {
        console.log(`  -> Sample too small (n=${prices.length}). Skipping.`);
        continue;
      }

      const rec = {
        avg: avg(prices),
        n: prices.length,
        currency: currency || null,
        productUrlsUsed: productUrls.length,
      };

      out[name] = rec;
      console.log(`  -> avg=${rec.avg?.toFixed?.(2)} n=${rec.n} ${rec.currency || ""}`);

      // be polite
      await sleep(200);
    } catch (e) {
      console.log(`  -> ERROR: ${e?.message || e}`);
      // keep going
      await sleep(200);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
