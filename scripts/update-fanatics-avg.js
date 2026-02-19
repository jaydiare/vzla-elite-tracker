// scripts/update-fanatics-avg.js
// Node 20+
//
// Phase 1: ONE actor run, ALL athletes
// Automatically builds Fanatics search URLs from data/athletes.json
//
// Env required:
//   FANATICS_SCRAPE

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
const ATHLETES_PATH = path.join(__dirname, "..", "data", "athletes.json");
const OUT_PATH = path.join(__dirname, "..", "data", "fanatics-avg.json");

const MAX_TOTAL_ITEMS = 2000; // adjust if needed

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

function loadAthletes() {
  const raw = fs.readFileSync(ATHLETES_PATH, "utf8");
  const arr = JSON.parse(raw);

  return arr
    .map(a => ({
      name: normSpaces(a.name),
      sport: normSpaces(a.sport),
      league: normSpaces(a.league),
      team: normSpaces(a.team)
    }))
    .filter(a => a.name);
}

function buildSearchUrl(athlete) {
  // Example: https://www.fanatics.com/search/andres%20chaparro%20baseball
  const query = encodeURIComponent(
    `${athlete.name} ${athlete.sport || ""}`.trim()
  );

  return `https://www.fanatics.com/search/${query}`;
}

async function runActor(startUrls) {
  const runUrl =
    `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/runs` +
    `?token=${encodeURIComponent(APIFY_TOKEN)}&waitForFinish=1200`;

  const input = {
    startUrls: startUrls.map(url => ({ url })),
    maxTotalItems: MAX_TOTAL_ITEMS
  };

  const res = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Apify run failed (${res.status}): ${txt}`);
  }

  const json = await res.json();
  const datasetId = json?.data?.defaultDatasetId;
  if (!datasetId) throw new Error("No dataset ID returned");

  const datasetUrl =
    `https://api.apify.com/v2/datasets/${datasetId}/items` +
    `?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true`;

  const itemsRes = await fetch(datasetUrl);
  return itemsRes.json();
}

async function main() {
  const athletes = loadAthletes();

  console.log(`Loaded ${athletes.length} athletes`);

  // Build ALL search URLs
  const searchUrls = athletes.map(buildSearchUrl);

  console.log("Running ONE actor call...");
  const items = await runActor(searchUrls);

  console.log(`Actor returned ${items.length} items`);

  const normalizedItems = items.map(it => ({
    name: normalizeForMatch(it.product_name || ""),
    price: safeNum(it.final_price),
    currency: it.currency || null
  }));

  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      athleteCount: athletes.length,
      actorId: ACTOR_ID
    }
  };

  for (const athlete of athletes) {
    const athleteNorm = normalizeForMatch(athlete.name);

    const matched = normalizedItems.filter(it =>
      it.name.includes(athleteNorm)
    );

    const prices = matched.map(m => m.price).filter(p => p != null);

    out[athlete.name] = {
      avg: avg(prices),
      n: prices.length,
      currency: matched.find(m => m.currency)?.currency || null
    };
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("Wrote fanatics-avg.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
