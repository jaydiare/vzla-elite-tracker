#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const ATHLETES_PATH = path.join(ROOT, "data", "athletes.json");
const OUTPUT_PATH = path.join(ROOT, "data", "ebay-avg.json");

// ✅ Both categories included
const CATEGORY_SPORTS_MEM_CARDS_FAN_SHOP = 888;  // Sports Mem, Cards & Fan Shop (parent)
const CATEGORY_SPORTS_TRADING_CARDS = 261328;    // Sports Trading Cards (subcategory)

// Default behavior: cards-focused search (like your example URL)
const DEFAULT_CATEGORY = CATEGORY_SPORTS_TRADING_CARDS;

// Fixed filters
const EBAY_HOST = "www.ebay.ca";
const CARD_SIZE_STANDARD = "Standard";

// eBay "Preferred Location": 2 = Canada
const PREF_LOC_CANADA = "2";

// Optional filters (toggle if you want)
const INCLUDE_FREE_SHIPPING_FILTER = true; // _fsrp=1
const INCLUDE_NO_CORRECTIONS = true;       // rt=nc

// Tuning
const MAX_PRICES_PER_ATHLETE = 60;
const TRIM_FRACTION = 0.10; // drop top/bottom 10% outliers
const SLEEP_MS_BETWEEN = 1200;
const MIN_SAMPLE_SIZE = 1; // still write avg even if small; UI can enforce min n

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

/**
 * Build eBay sold/completed URL for an athlete.
 *
 * athletes.json supports optional fields:
 * - keywords: string (defaults to name)
 * - category: number (defaults to DEFAULT_CATEGORY)
 * - cardSize: string (defaults to "Standard"; set null to omit)
 * - prefLoc: string (defaults to Canada "2"; set null to omit)
 * - freeShipping: boolean (override INCLUDE_FREE_SHIPPING_FILTER)
 * - noCorrections: boolean (override INCLUDE_NO_CORRECTIONS)
 */
function buildEbaySoldUrl(athlete) {
  const name = String(athlete?.name || "").trim();
  if (!name) throw new Error("Athlete missing name");

  const kw = encodePlus(String(athlete?.keywords || name));

  const category = Number.isFinite(Number(athlete?.category))
    ? Number(athlete.category)
    : DEFAULT_CATEGORY;

  const cardSize = athlete?.cardSize === undefined ? CARD_SIZE_STANDARD : athlete.cardSize;
  const prefLoc = athlete?.prefLoc === undefined ? PREF_LOC_CANADA : athlete.prefLoc;

  const freeShipping =
    athlete?.freeShipping === undefined ? INCLUDE_FREE_SHIPPING_FILTER : !!athlete.freeShipping;

  const noCorrections =
    athlete?.noCorrections === undefined ? INCLUDE_NO_CORRECTIONS : !!athlete.noCorrections;

  const params = new URLSearchParams();

  // Core filters
  params.set("_dcat", String(category));
  params.set("_nkw", kw);
  params.set("LH_Complete", "1");
  params.set("LH_Sold", "1");

  // Optional filters to match your example
  if (freeShipping) params.set("_fsrp", "1");
  if (noCorrections) params.set("rt", "nc");
  if (prefLoc != null && String(prefLoc).trim() !== "") params.set("LH_PrefLoc", String(prefLoc));

  // Card size filter (optional; set null/"" per athlete to omit)
  if (cardSize != null && String(cardSize).trim() !== "") {
    params.set("Card Size", String(cardSize));
  }

  const base = `https://${EBAY_HOST}/sch/i.html?${params.toString()}`;

  // Player/Athlete aspect filter
  // Use single-encoded key: Player%2FAthlete
  const playerAspect = `&Player%2FAthlete=${encodeURIComponent(name)}`;

  return base + playerAspect;
}

// CodeQL-friendly stripTags: allow attributes/whitespace in closing tags
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "\n");
}

function parseCadValues(line) {
  // Extract occurrences like "C $12.34" or "C $1,234.56"
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

function extractSoldCadPricesFromHtml(html, maxPrices
