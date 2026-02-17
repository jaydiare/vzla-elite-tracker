#!/usr/bin/env node
/**
 * scripts/update-ebay-avg.js
 *
 * Option A:
 * - This script reads ONLY ./data/athletes.json
 * - Make sure "Jackson Chourio" is added there so he gets an avg entry.
 *
 * What it does:
 * - Builds an eBay.ca SOLD + COMPLETED search URL per athlete (cards-focused)
 * - Extracts sold prices (supports CAD "C $" AND USD "US $")
 * - Prefers CAD if available, otherwise uses USD
 * - Computes a trimmed mean (drops top/bottom 10%) to reduce outliers
 * - Writes ./data/ebay-avg.json keyed by athlete name
 *
 * Changes in this version (Worldwide):
 * - ✅ DOES NOT filter items located in Canada (removes LH_PrefLoc entirely)
 *   (Worldwide is the default when LH_PrefLoc is omitted)
 * - Avoids double-encoding _nkw (URLSearchParams handles encoding)
 * - Normalizes diacritics and punctuation for Player/Athlete aspect (Acuña -> Acuna, Jr. -> Jr)
 * - Adds a fallback pass if strict filters return 0 sold prices:
 *   - fallback removes Player/Athlete aspect and removes Card Size filter
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const ATHLETES_PATH = path.join(ROOT, "data", "athletes.json");
const OUTPUT_PATH = path.join(ROOT, "data", "ebay-avg.json");

// ✅ Both categories included (override per athlete via athletes.json "category" if desired)
const CATEGORY_SPORTS_MEM_CARDS_FAN_SHOP = 888; // parent
const CATEGORY_SPORTS_TRADING_CARDS = 261328;   // cards-focused

// Default: cards-only signal
const DEFAULT_CATEGORY = CATEGORY_SPORTS_TRADING_CARDS;

// Fixed search settings (matching your preferred URL style)
const EBAY_HOST = "www.ebay.ca";
const CARD_SIZE_STANDARD = "Standard";
const RT_NO_CORRECTIONS = "nc"; // rt=nc

// Tuning
const MAX_PRICES_PER_ATHLETE = 60;
const TRIM_FRACTION = 0.10; // drop top/bottom 10%
const SLEEP_MS_BETWEEN = 1200;

/** Remove accents/diacritics (Suárez -> Suarez, Acuña -> Acuna, Álvarez -> Alvarez) */
function stripDiacritics(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Normalize for eBay item specifics / search stability */
function normalizeForSearch(s) {
  return stripDiacritics(String(s))
    .replace(/\./g, "") // Jr. -> Jr
    .replace(/\s+/g, " ")
    .trim();
}

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

function categoryForAthlete(athlete) {
  const n = Number(athlete?.category);
  return Number.isFinite(n) ? n : DEFAULT_CATEGORY;
}

/**
 * athletes.json supports optional:
 * - keywords: string (defaults to name + " card")
 * - category: number (defaults to DEFAULT_CATEGORY)
 *
 * Example athletes.json entry:
 * { "name": "Jackson Chourio" }
 * { "name": "Player X", "keywords": "player x rookie card", "category": 888 }
 */
function buildEbaySoldUrl(athlete, opts = {}) {
  const nameRaw = String(athlete?.name || "").trim();
  if (!nameRaw) throw new Error("Athlete missing name");

  const nameNorm = normalizeForSearch(nameRaw);

  // IMPORTANT: do NOT pre-encode. Let URLSearchParams handle encoding.
  const kwRaw = String(athlete?.keywords || `${nameNorm} card`).trim();

  const category = categoryForAthlete(athlete);

  const params = new URLSearchParams();

  // Core filters
  params.set("_dcat", String(category));
  params.set("_nkw", kwRaw);
  params.set("LH_Complete", "1");
  params.set("LH_Sold", "1");

  // ✅ Worldwide: DO NOT set LH_PrefLoc at all

  // No autocorrect
  params.set("rt", RT_NO_CORRECTIONS);

  // Card size filter (strict pass only)
  if (!opts.loose) {
    params.set("Card Size", CARD_SIZE_STANDARD);
  }

  const base = `https://${EBAY_HOST}/sch/i.html?${params.toString()}`;

  // Player/Athlete aspect filter (strict pass only; can be too strict for some stars)
  if (!opts.noAspect) {
    const playerAspect = `&Player%2FAthlete=${encodeURIComponent(nameNorm)}`;
    return base + playerAspect;
  }

  return base;
}

// CodeQL-friendly tag stripper: allow attributes/whitespace in closing tags
function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "\n");
}

/**
 * Extract money from a line:
 * - CAD: "C $12.34"
 * - USD: "US $12.34"
 */
function parseMoneyValues(line) {
  const out = [];
  for (const m of line.matchAll(/\b(C|US)\s*\$\s*([\d,.]+)/g)) {
    const currency = m[1] === "C" ? "CAD" : "USD";
    const value = Number(m[2].replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) out.push({ currency, value });
  }
  return out;
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

function extractSoldMoneyFromHtml(html, maxItems = 60) {
  // Parse based on “Sold <date>” markers visible in eBay sold search results.
  const text = stripTags(html);
  const lines = text
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  /** @type {{currency:"CAD"|"USD", value:number}[]} */
  const picks = [];

  for (let i = 0; i < lines.length && picks.length < maxItems; i++) {
    if (lines[i].startsWith("Sold ")) {
      // Look ahead for a money line near the "Sold ..." marker
      for (let j = i + 1; j < Math.min(i + 14, lines.length); j++) {
        const l = lines[j];

        // Skip ranges like "C $1.35 to C $5.43"
        if (
          /\bto\b/i.test(l) &&
          /\b(C|US)\s*\$\s*[\d,.]+\s+to\s+\b(C|US)\s*\$\s*[\d,.]+/i.test(l)
        ) {
          continue;
        }

        const vals = parseMoneyValues(l);
        if (vals.length) {
          // If multiple money values appear, take the last
          picks.push(vals[vals.length - 1]);
          break;
        }
      }
    }
  }

  return picks;
}

function chooseCurrencyAndAvg(picks) {
  const cad = picks.filter((p) => p.currency === "CAD").map((p) => p.value);
  const usd = picks.filter((p) => p.currency === "USD").map((p) => p.value);

  // Prefer CAD if we have any CAD samples, otherwise use USD
  if (cad.length) {
    const avg = trimmedMean(cad, TRIM_FRACTION);
    return { currency: "CAD", n: cad.length, avg };
  }
  if (usd.length) {
    const avg = trimmedMean(usd, TRIM_FRACTION);
    return { currency: "USD", n: usd.length, avg };
  }
  return { currency: "CAD", n: 0, avg: null };
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

    const categoryUsed = categoryForAthlete(a);

    // Pass 1 (strict): Player/Athlete + Card Size
    let url = buildEbaySoldUrl(a, { noAspect: false, loose: false });

    try {
      let html = await fetchHtml(url);
      let picks = extractSoldMoneyFromHtml(html, MAX_PRICES_PER_ATHLETE);

      // Pass 2 (fallback): remove Player/Athlete aspect + remove Card Size filter
      if (!picks.length) {
        url = buildEbaySoldUrl(a, { noAspect: true, loose: true });
        html = await fetchHtml(url);
        picks = extractSoldMoneyFromHtml(html, MAX_PRICES_PER_ATHLETE);
      }

      const chosen = chooseCurrencyAndAvg(picks);

      out[name] = {
        avg: chosen.avg != null ? round2(chosen.avg) : null,
        n: chosen.n,
        currency: chosen.currency,
        asOf: nowIso,
        source: url,
        method: `trimmed_mean_${Math.round(TRIM_FRACTION * 100)}pct`,
        filters: {
          category: categoryUsed,
          // Note: Card Size and Player/Athlete may be absent in fallback pass
          cardSize: CARD_SIZE_STANDARD,
          sold: true,
          completed: true,
          rt: RT_NO_CORRECTIONS,
          site: "ebay.ca",
          prefLoc: "worldwide",
        },
      };

      console.log(
        `[${idx + 1}/${athletes.length}] ${name}: n=${chosen.n} avg=${
          chosen.avg != null
            ? `${chosen.currency === "USD" ? "US$" : "C$"}${round2(chosen.avg)}`
            : "null"
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
