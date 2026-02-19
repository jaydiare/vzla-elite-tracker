// scripts/update-fanatics-avg.js
// Node 20+
//
// Runs Apify actor ONCE for all tracked Fanatics.com product URLs,
// then groups results by athlete and computes average final_price.
//
// Env required:
//   FANATICS_SCRAPE  (Apify token)
//
// Input file:
//   data/fanatics-tracked-urls.json  (array of { athlete, urls: [] })
//
// Output:
//   data/fanatics-avg.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APIFY_TOKEN = process.env.FANATICS_SCRAPE;
if (!APIFY_TOKEN) {
  console.error("Missing FANATICS_SCRAPE in env.");
  process.exit(1);
}

const ACTOR_ID = "fortuitous_pirate/fanatics-scraper";

const TRACKED_PATH = path.join(__dirname, "..", "data", "fanatics-tracked-urls.json");
const OUT_PATH = path.join(__dirname, "..", "data", "fanatics-avg.json");

function normSpaces(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripDiacritics(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeForMatch(s) {
  return normSpaces(
    stripDiacritics(s)
      .toLowerCase()
      .replace(/[.'’"]/g, "")
  );
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function loadTracked() {
  if (!fs.existsSync(TRACKED_PATH)) {
    throw new Error(
      `Missing ${TRACKED_PATH}. Create it as an array: [{ athlete: "Name", urls: ["https://www.fanatics.com/..."] }]`
    );
  }
  const raw = fs.readFileSync(TRACKED_PATH, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("fanatics-tracked-urls.json must be an array.");

  return arr
    .map((x) => ({
      athlete: normSpaces(x?.athlete),
      urls: Array.isArray(x?.urls) ? x.urls.filter(Boolean) : [],
    }))
    .filter((x) => x.athlete && x.urls.length);
}

async function runActor(productUrls, maxTotalItems) {
  const startUrl =
    `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/runs` +
    `?token=${encodeURIComponent(APIFY_TOKEN)}&waitForFinish=1200`;

  const input = {
    productUrls,
    maxTotalItems,
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
  const datasetId = runJson?.data?.defaultDatasetId;
  if (!datasetId) throw new Error("No defaultDatasetId returned from Apify.");

  const itemsUrl =
    `https://api.apify.com/v2/datasets/${datasetId}/items` +
    `?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true`;

  const itemsRes = await fetch(itemsUrl);
  if (!itemsRes.ok) {
    const txt = await itemsRes.text().catch(() => "");
    throw new Error(`Apify dataset fetch failed (${itemsRes.status}): ${txt}`);
  }

  return itemsRes.json();
}

async function main() {
  const tracked = loadTracked();

  // Build a single deduped URL list for ONE actor run
  const allUrls = [...new Set(tracked.flatMap((t) => t.urls))];
  console.log(`Tracked athletes: ${tracked.length}`);
  console.log(`Total unique product URLs: ${allUrls.length}`);

  // Actor may output multiple rows per product (sizes/variants). Give headroom:
  const MAX_TOTAL_ITEMS = Math.min(Math.max(allUrls.length * 20, 200), 5000);

  console.log(`Running actor once (maxTotalItems=${MAX_TOTAL_ITEMS})...`);
  const items = await runActor(allUrls, MAX_TOTAL_ITEMS);
  console.log(`Actor returned ${items?.length || 0} rows`);

  // Pre-normalize items for matching
  const normalizedItems = (items || []).map((it) => ({
    raw: it,
    name: normalizeForMatch(it?.product_name || ""),
    final_price: safeNum(it?.final_price),
    currency: it?.currency || null,
    url: it?.url || null,
    in_stock: it?.in_stock ?? null,
  }));

  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      actorId: ACTOR_ID,
      trackedAthletes: tracked.length,
      trackedUrls: allUrls.length,
      note:
        "Averages computed from Apify Fanatics.com scraper output (final_price). Results grouped by athlete name match in product_name.",
    },
  };

  for (const t of tracked) {
    const athleteKey = t.athlete;
    const athleteNorm = normalizeForMatch(athleteKey);

    // Match rows where product_name contains athlete name
    const matched = normalizedItems.filter((it) => it.name.includes(athleteNorm));

    const prices = matched.map((m) => m.final_price).filter((p) => p != null);

    if (!prices.length) {
      out[athleteKey] = { avg: null, n: 0, currency: null };
      continue;
    }

    // Currency: pick the first non-null (Fanatics.com usually consistent)
    const currency = matched.find((m) => m.currency)?.currency || null;

    out[athleteKey] = {
      avg: avg(prices),
      n: prices.length,
      currency,
      // optional debug: how many urls you tracked for this athlete
      trackedUrls: t.urls.length,
    };
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
