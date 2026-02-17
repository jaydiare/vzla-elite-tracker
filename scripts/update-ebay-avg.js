#!/usr/bin/env node
/**
 * scripts/update-ebay-avg.js
 *
 * What it does:
 * - Reads ./data/athletes.json
 * - Builds eBay.ca SOLD + COMPLETED search URLs per athlete (cards-focused)
 * - Fetches results HTML (with anti-bot detection)
 * - Extracts sold prices (CAD "C $" and USD "US $")
 * - Prefers CAD if available, otherwise uses USD
 * - Computes a trimmed mean (drops top/bottom 10%) to reduce outliers
 * - Writes ./data/ebay-avg.json keyed by athlete name
 *
 * Important:
 * - ✅ Worldwide results (no LH_PrefLoc)
 * - ✅ Robust extraction (no longer depends on "Sold " line starts)
 * - ✅ Detects bot/consent/captcha pages (prevents silent n=0)
 * - ✅ Runs in batches of 20, waits 2 minutes between batches (to reduce blocking)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const ATHLETES_PATH = path.join(ROOT, "data", "athletes.json");
const OUTPUT_PATH = path.join(ROOT, "data", "ebay-avg.json");

// Categories (override per athlete via athletes.json "category" if desired)
const CATEGORY_SPORTS_TRADING_CARDS = 261328; // cards-focused
const DEFAULT_CATEGORY = CATEGORY_SPORTS_TRADING_CARDS;

// eBay host
const EBAY_HOST = "www.ebay.ca";

// Search tuning
const CARD_SIZE_STANDARD = "Standard";
const RT_NO_CORRECTIONS = "nc";
const MAX_PRICES_PER_ATHLETE = 40;
const TRIM_FRACTION = 0.10;

// Rate limiting / batching (your request)
const BATCH_SIZE = 20;
const BATCH_SLEEP_MS = 2 * 60 * 1000; // 2 minutes
const SLEEP_MS_BETWEEN = 1200;        // base per-request sleep inside a batch
const SLEEP_JITTER_MS = 600;          // adds randomness (0..600ms)

// Fetch tuning
const FETCH_RETRIES = 2;
const FETCH_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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

/** Remove accents/diacritics */
function stripDiacritics(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Normalize for search stability */
function normalizeForSearch(s) {
  return stripDiacritics(String(s))
    .replace(/\./g, "") // Jr. -> Jr
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryForAthlete(athlete) {
  const n = Number(athlete?.category);
  return Number.isFinite(n) ? n : DEFAULT_CATEGORY;
}

/**
 * Build eBay SOLD+COMPLETED URL.
 * opts:
 * - loose: omit Card Size filter
 * - noCategory: omit category filter (last resort)
 */
function buildEbaySoldUrl(athlete, opts = {}) {
  const nameRaw = String(athlete?.name || "").trim();
  if (!nameRaw) throw new Error("Athlete missing name");

  const nameNorm = normalizeForSearch(nameRaw);
  const kw = normalizeForSearch(String(athlete?.keywords || `${nameNorm} card`).trim());
  const category = categoryForAthlete(athlete);

  const params = new URLSearchParams();

  params.set("_nkw", kw);
  params.set("LH_Complete", "1");
  params.set("LH_Sold", "1");
  params.set("rt", RT_NO_CORRECTIONS);

  if (!opts.noCategory) params.set("_sacat", String(category));
  if (!opts.loose) params.set("Card Size", CARD_SIZE_STANDARD);

  return `https://${EBAY_HOST}/sch/i.html?${params.toString()}`;
}

// CodeQL-friendly tag stripper
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

function detectBlockedOrConsent(html) {
  const lowered = html.toLowerCase();
  const blockedSignals = [
    "robot check",
    "pardon our interruption",
    "access denied",
    "verify you are human",
    "enable cookies",
    "captcha",
    "/challenge/",
    "press and hold",
    "security measure",
    "consent",
    "gdpr",
  ];
  return blockedSignals.some((s) => lowered.includes(s));
}

function looksLikeResultsPage(html) {
  const lowered = html.toLowerCase();
  return (
    lowered.includes("s-item") ||
    lowered.includes("srp-river-results") ||
    lowered.includes("srp-controls") ||
    lowered.includes("results for")
  );
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; VzlaSportsEliteBot/1.0; +https://github.com/)",
        "accept-language": "en-CA,en;q=0.9",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();

    if (detectBlockedOrConsent(html)) {
      throw new Error("Blocked/consent/captcha page detected (eBay anti-bot).");
    }
    if (!looksLikeResultsPage(html)) {
      throw new Error("Unexpected eBay response (not a results page).");
    }

    return { html, finalUrl: res.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHtmlWithRetry(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchHtml(url);
    } catch (e) {
      lastErr = e;
      await sleep(800 * attempt + randInt(0, 400));
    }
  }
  throw lastErr || new Error("Fetch failed");
}

/**
 * Robust extraction:
 * - Pass A: marker-based (Sold/Ended/Completed nearby)
 * - Pass B: fallback scan for money values if marker pass fails
 */
function extractSoldMoneyFromHtml(html, maxItems = 60) {
  const text = stripTags(html);
  const lines = text
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  /** @type {{currency:"CAD"|"USD", value:number}[]} */
  const picks = [];

  const isMarker = (s) =>
    /\bsold\b/i.test(s) || /\bended\b/i.test(s) || /\bcompleted\b/i.test(s);

  const isRange = (s) =>
    /\bto\b/i.test(s) &&
    /\b(C|US)\s*\$\s*[\d,.]+\s+to\s+\b(C|US)\s*\$\s*[\d,.]+/i.test(s);

  const isNoise = (s) =>
    /sponsored/i.test(s) ||
    /results matching/i.test(s) ||
    /shop on ebay/i.test(s) ||
    /see all/i.test(s) ||
    /advertisement/i.test(s);

  // Pass A: marker + nearby price
  for (let i = 0; i < lines.length && picks.length < maxItems; i++) {
    const li = lines[i];
    if (!isMarker(li)) continue;

    for (let j = i + 1; j < Math.min(i + 50, lines.length); j++) {
      const l = lines[j];
      if (isNoise(l) || isRange(l)) continue;

      const vals = parseMoneyValues(l);
      if (vals.length) {
        picks.push(vals[vals.length - 1]);
        break;
      }
    }
  }

  // Pass B: scan for money values (fallback)
  if (!picks.length) {
    for (const l of lines) {
      if (isNoise(l) || isRange(l)) continue;
      const vals = parseMoneyValues(l);
      if (vals.length) {
        picks.push(vals[vals.length - 1]);
        if (picks.length >= maxItems) break;
      }
    }
  }

  return picks;
}

function chooseCurrencyAndAvg(picks) {
  const cad = picks.filter((p) => p.currency === "CAD").map((p) => p.value);
  const usd = picks.filter((p) => p.currency === "USD").map((p) => p.value);

  if (cad.length) return { currency: "CAD", n: cad.length, avg: trimmedMean(cad, TRIM_FRACTION) };
  if (usd.length) return { currency: "USD", n: usd.length, avg: trimmedMean(usd, TRIM_FRACTION) };
  return { currency: "CAD", n: 0, avg: null };
}

async function fetchPicksWithFallbacks(athlete) {
  const strategies = [
    { label: "cat+kw+size", opts: { loose: false, noCategory: false } },
    { label: "cat+kw", opts: { loose: true, noCategory: false } },
    { label: "kw_only", opts: { loose: true, noCategory: true } },
  ];

  let last = null;

  for (const s of strategies) {
    const url = buildEbaySoldUrl(athlete, s.opts);
    const { html, finalUrl } = await fetchHtmlWithRetry(url);
    const picks = extractSoldMoneyFromHtml(html, MAX_PRICES_PER_ATHLETE);
    last = { url, finalUrl, picks, strategy: s.label };
    if (picks.length) return last;
  }

  return last || { url: null, finalUrl: null, picks: [], strategy: "none" };
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

    // Batch pause: after every BATCH_SIZE athletes, wait 2 minutes (except after last)
    if (idx > 0 && idx % BATCH_SIZE === 0) {
      console.log(
        `--- Batch pause: processed ${idx}/${athletes.length}. Sleeping ${Math.round(
          BATCH_SLEEP_MS / 1000
        )}s ---`
      );
      await sleep(BATCH_SLEEP_MS);
    }

    try {
      const { url, finalUrl, picks, strategy } = await fetchPicksWithFallbacks(a);
      const chosen = chooseCurrencyAndAvg(picks);

      out[name] = {
        avg: chosen.avg != null ? round2(chosen.avg) : null,
        n: chosen.n,
        currency: chosen.currency,
        asOf: nowIso,
        source: url,
        finalUrl: finalUrl || url,
        strategy,
        method: `trimmed_mean_${Math.round(TRIM_FRACTION * 100)}pct`,
        filters: {
          category: categoryForAthlete(a),
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
        error: String(e?.message || e),
      };
      console.warn(`[${idx + 1}/${athletes.length}] ${name}: ERROR ${e?.message || e}`);
    }

    // Sleep between athletes with jitter
    if (idx < athletes.length - 1) {
      await sleep(SLEEP_MS_BETWEEN + randInt(0, SLEEP_JITTER_MS));
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
