#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const ATHLETES_PATH = path.join(ROOT, "data", "athletes.json");
const OUTPUT_PATH = path.join(ROOT, "data", "ebay-avg.json");

// Fixed filters for “athlete cards”
const EBAY_HOST = "www.ebay.ca";
const CATEGORY_SPORTS_TRADING_CARDS = 261328;
const CARD_SIZE_STANDARD = "Standard";
const FCID_CANADA = 2;

// Tuning
const MAX_PRICES_PER_ATHLETE = 60;
const TRIM_FRACTION = 0.10; // drop top/bottom 10%
const SLEEP_MS_BETWEEN = 1200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDirExists(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readAthletes() {
  if (!fs.existsSync(ATHLETES_PATH)) {
    throw new Error(`Missing ${ATHLETES_PATH}. Create data/athletes.json first.`);
  }
  const raw = fs.readFileSync(ATHLETES_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("data/athletes.json must be an array");
  return parsed;
}

function encodePlus(s) {
  return s.trim().split(/\s+/).map(encodeURIComponent).join("+");
}

function buildEbaySoldUrl({ name, keywords }) {
  const kw = encodePlus((keywords && String(keywords)) || String(name));

  // We set the fixed card filters + sold/completed.
  // Add Player/Athlete aspect filter too, using the athlete name.
  const params = new URLSearchParams();
  params.set("_nkw", kw);
  params.set("_dcat", String(CATEGORY_SPORTS_TRADING_CARDS));
  params.set("_sop", "13"); // ended recently
  params.set("_svsrch", "1");
  params.set("LH_Complete", "1");
  params.set("LH_Sold", "1");
  params.set("_fcid", String(FCID_CANADA));
  params.set("Card Size", CARD_SIZE_STANDARD);

  // Player/Athlete aspect key must preserve the slash in the key.
  // URLSearchParams will encode it as Player%2FAthlete automatically,
  // but it can be finicky; we append it manually for consistency.
  const base = `https://${EBAY_HOST}/sch/i.html?${params.toString()}`;
  const playerAspect = `&Player%2FAthlete=${encodeURIComponent(String(name))}`;

  return base + playerAspect;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script[^<]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style[^<]*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript[^<]*>/gi, " ")
    .replace(/<[^>]+>/g, "\n");
}

function parseCadValues(line) {
  const matches = [...line.matchAll(/C\s*\$\s*([\d,.]+)/g)];
  return matches
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function trimmedMean(values, trimFraction = 0.10) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const k = Math.floor(sorted.length * trimFraction);
  const trimmed = sorted.slice(k, sorted.length - k);
  if (!trimmed.length) return null;
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; VzlaSportsEliteBot/1.0; +https://github.com/)",
      "accept-language": "en-CA,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

function extractSoldCadPricesFromHtml(html, maxPrices = 60) {
  const text = stripTags(html);
  const lines = text
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const prices = [];

  for (let i = 0; i < lines.length && prices.length < maxPrices; i++) {
    if (lines[i].startsWith("Sold ")) {
      // Look ahead for a CAD sold price line near the "Sold <date>" marker.
      for (let j = i + 1; j < Math.min(i + 14, lines.length); j++) {
        const l = lines[j];

        // Skip ranges like "C $1.35 to C $5.43"
        if (/\bto\b/i.test(l) && /C\s*\$\s*[\d,.]+\s+to\s+C\s*\$\s*[\d,.]+/i.test(l)) {
          continue;
        }

        const nums = parseCadValues(l);
        if (nums.length) {
          prices.push(nums[nums.length - 1]);
          break;
        }
      }
    }
  }

  return prices;
}

async function main() {
  const athletes = readAthletes();

  ensureDirExists(path.dirname(OUTPUT_PATH));

  const out = {};
  const nowIso = new Date().toISOString();

  for (let idx = 0; idx < athletes.length; idx++) {
    const a = athletes[idx];
    const name = a?.name?.trim();
    if (!name) continue;

    const url = buildEbaySoldUrl(a);

    try {
      const html = await fetchHtml(url);
      const prices = extractSoldCadPricesFromHtml(html, MAX_PRICES_PER_ATHLETE);
      const avg = trimmedMean(prices, TRIM_FRACTION);

      out[name] = {
        avg: avg != null ? round2(avg) : null,
        n: prices.length,
        currency: "CAD",
        asOf: nowIso,
        source: url,
        method: `trimmed_mean_${Math.round(TRIM_FRACTION * 100)}pct`,
        filters: {
          category: CATEGORY_SPORTS_TRADING_CARDS,
          cardSize: CARD_SIZE_STANDARD,
          sold: true,
          completed: true,
          sort: "ended_recently",
          site: "ebay.ca",
        },
      };

      console.log(
        `[${idx + 1}/${athletes.length}] ${name}: n=${prices.length} avg=${
          avg != null ? `C$${round2(avg)}` : "null"
        }`
      );
    } catch (e) {
      out[name] = {
        avg: null,
        n: 0,
        currency: "CAD",
        asOf: nowIso,
        source: url,
        error: String(e?.message || e),
      };
      console.warn(`[${idx + 1}/${athletes.length}] ${name}: ERROR ${e?.message || e}`);
    }

    if (idx < athletes.length - 1) await sleep(SLEEP_MS_BETWEEN);
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

