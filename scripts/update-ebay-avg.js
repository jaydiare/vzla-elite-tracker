// scripts/update-ebay-avg.js
// Dual marketplace (EBAY_US + EBAY_CA) ACTIVE LISTING (Buy Now only) averages via eBay Buy Browse API.
// - No Marketplace Insights scopes (no sold data)
// - Buy Now only (FIXED_PRICE)
// - Validates results by requiring at least one listing where aspect "Player/Athlete" matches the athlete name
// - Uses name + sport in the query for better accuracy
// - Includes graded/ungraded, includes listings under $1
//
// Output: data/ebay-avg.json
// Shape (per athlete):
// {
//   "Jose Altuve": {
//     "avg": 21.37,              // primary avg = EBAY_CA avg (CAD) when available
//     "n": 42,                   // primary sample count = EBAY_CA n
//     "currency": "CAD",
//     "marketplaces": {
//       "EBAY_CA": { "avg": 21.37, "n": 42, "currency": "CAD" },
//       "EBAY_US": { "avg": 16.11, "n": 38, "currency": "USD" }
//     },
//     "asOf": "2026-02-17T00:00:00.000Z"
//   }
// }

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ATHLETES_PATH = path.resolve("data/athletes.json");
const OUT_PATH = path.resolve("data/ebay-avg.json");

const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

const MARKETPLACES = ["EBAY_US", "EBAY_CA"];

// Browse API limits
const LIMIT = 50;
const MAX_PAGES = 3; // 150 items max per marketplace
const REQUEST_TIMEOUT_MS = 20_000;

// Trim outliers when sample size is decent
const TRIM_PERCENT = 0.10; // 10% from each side
const MIN_FOR_TRIM = 10;

// -------------------- helpers --------------------

function norm(v) {
  return (v ?? "").toString().trim().toLowerCase();
}

function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function compactSpaces(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normalizeNameForCompare(s) {
  // lower + strip diacritics + remove punctuation-ish
  const base = stripDiacritics(norm(s));
  return base.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function splitNameTokens(fullName) {
  const clean = normalizeNameForCompare(fullName);
  const tokens = clean.split(" ").filter(Boolean);

  // Remove common suffixes that often appear in athlete names
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
  const filtered = tokens.filter((t) => !suffixes.has(t));

  const first = filtered[0] || "";
  const last = filtered.length ? filtered[filtered.length - 1] : "";
  const firstInitial = first ? first[0] : "";

  return { tokens: filtered, first, last, firstInitial };
}

function aspectValues(item, aspectName) {
  const aspects = item?.aspects;
  if (!Array.isArray(aspects)) return [];
  const target = aspects.find((a) => norm(a?.name) === norm(aspectName));
  const vals = target?.values;
  if (!Array.isArray(vals)) return [];
  return vals.map((v) => compactSpaces(v)).filter(Boolean);
}

function getPlayerAthleteAspectValues(item) {
  // Most common is "Player/Athlete", but some categories use "Athlete" or similar.
  const candidates = ["Player/Athlete", "Athlete", "Player", "Player/Athlete(s)"];
  const all = [];
  for (const c of candidates) {
    all.push(...aspectValues(item, c));
  }
  // Deduplicate
  return Array.from(new Set(all));
}

function athleteNameMatchesAspect(athleteName, aspectValue) {
  // We want strong-enough matching to avoid false positives,
  // but still catch diacritics differences and minor formatting.
  //
  // Rules:
  // - Full normalized name contained => match
  // - Else: must match last name AND (first name OR first initial)
  const a = splitNameTokens(athleteName);
  if (!a.last) return false;

  const aspectNorm = normalizeNameForCompare(aspectValue);

  const fullNorm = normalizeNameForCompare(athleteName);
  if (fullNorm && aspectNorm.includes(fullNorm)) return true;

  // Token-level checks
  const hasLast = a.last && aspectNorm.split(" ").includes(a.last);
  if (!hasLast) return false;

  const words = new Set(aspectNorm.split(" ").filter(Boolean));
  const hasFirst = a.first && words.has(a.first);
  const hasFirstInitial = a.firstInitial
    ? Array.from(words).some((w) => w.length === 1 && w === a.firstInitial)
    : false;

  // Also allow something like "ronald acuna" vs "ronald acuna jr"
  // because suffixes are removed already.
  return hasFirst || hasFirstInitial;
}

function itemMatchesAthlete(item, athleteName) {
  const vals = getPlayerAthleteAspectValues(item);
  if (!vals.length) return false;

  for (const v of vals) {
    if (athleteNameMatchesAspect(athleteName, v)) return true;
  }
  return false;
}

function extractFixedPriceValue(item) {
  // Browse API item summary uses item.price.value + item.price.currency
  const val = Number(item?.price?.value);
  const cur = item?.price?.currency;
  if (!Number.isFinite(val) || val < 0) return null;
  return { value: val, currency: cur || null };
}

function trimmedMean(values) {
  const nums = values.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  const n = nums.length;
  if (!n) return null;

  if (n >= MIN_FOR_TRIM) {
    const cut = Math.floor(n * TRIM_PERCENT);
    const sliced = nums.slice(cut, n - cut);
    if (sliced.length) {
      const sum = sliced.reduce((a, b) => a + b, 0);
      return sum / sliced.length;
    }
  }

  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / n;
}

async function withTimeout(promise, ms, label = "request") {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await promise(ac.signal);
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`${label} timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- eBay auth + browse --------------------

async function getAppToken() {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
    throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET env vars");
  }

  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  // IMPORTANT: only the base scope you have access to
  body.set("scope", "https://api.ebay.com/oauth/api_scope");

  const res = await withTimeout(
    (signal) =>
      fetch("https://api.ebay.com/identity/v1/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body,
        signal,
      }),
    REQUEST_TIMEOUT_MS,
    "token request"
  );

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Failed to get eBay token (${res.status}): ${JSON.stringify(json)}`);
  }
  if (!json?.access_token) {
    throw new Error(`Failed to get eBay token: missing access_token`);
  }

  return json.access_token;
}

async function browseSearch({ token, marketplaceId, q, limit, offset }) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  // Buy Now only (no auctions)
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");

  const res = await withTimeout(
    (signal) =>
      fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        },
        signal,
      }),
    REQUEST_TIMEOUT_MS,
    `browse search (${marketplaceId})`
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Browse API error (${marketplaceId}) ${res.status}: ${text}`);
  }

  return res.json();
}

async function fetchMarketplaceActiveMatches({ token, marketplaceId, athleteName, sport }) {
  // Query: name + sport (more accurate)
  // Add "card" because you're tracking collectibles cards; if you want broader items, remove "card".
  const q = compactSpaces(`${athleteName} ${sport} card`);

  const matchedPrices = [];
  let currency = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * LIMIT;
    const data = await browseSearch({ token, marketplaceId, q, limit: LIMIT, offset });

    const items = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];
    if (!items.length) break;

    for (const item of items) {
      // Must match via Player/Athlete aspect (or equivalent)
      if (!itemMatchesAthlete(item, athleteName)) continue;

      const p = extractFixedPriceValue(item);
      if (!p) continue;

      matchedPrices.push(p.value);
      // currency should be consistent per marketplace; grab first seen
      if (!currency && p.currency) currency = p.currency;
    }

    // If fewer items returned than limit, no more pages
    if (items.length < LIMIT) break;
  }

  const avg = trimmedMean(matchedPrices);
  return {
    avg: avg == null ? null : Number(avg.toFixed(2)),
    n: matchedPrices.length,
    currency: currency || null,
    query: q,
  };
}

// -------------------- IO --------------------

async function readAthletes() {
  const raw = await fs.readFile(ATHLETES_PATH, "utf8");
  const json = JSON.parse(raw);

  if (!Array.isArray(json)) {
    throw new Error(`Expected data/athletes.json to be an array`);
  }

  // normalize fields
  const cleaned = json
    .map((a) => ({
      name: compactSpaces(a?.name || ""),
      sport: compactSpaces(a?.sport || ""),
    }))
    .filter((a) => a.name && a.sport);

  // dedupe by name+sport
  const map = new Map();
  for (const a of cleaned) {
    const key = `${normalizeNameForCompare(a.name)}|${normalizeNameForCompare(a.sport)}`;
    if (!map.has(key)) map.set(key, a);
  }

  return Array.from(map.values()).sort((x, y) => x.name.localeCompare(y.name));
}

async function writeJsonPretty(filePath, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  await fs.writeFile(filePath, text, "utf8");
}

// -------------------- main --------------------

async function main() {
  const athletes = await readAthletes();
  const token = await getAppToken();

  const out = {};
  const asOf = new Date().toISOString();

  let i = 0;
  for (const a of athletes) {
    i += 1;
    console.log(`[${i}/${athletes.length}] ${a.name} (${a.sport})`);

    let results;
    try {
      results = await Promise.all(
        MARKETPLACES.map((marketplaceId) =>
          fetchMarketplaceActiveMatches({
            token,
            marketplaceId,
            athleteName: a.name,
            sport: a.sport,
          }).then((r) => ({ marketplaceId, ...r }))
        )
      );
    } catch (e) {
      console.error(`${a.name}: ERROR (${e?.message || e})`);
      continue;
    }

    const byMp = {};
    let anyPlayerAthleteMatch = false;

    for (const r of results) {
      byMp[r.marketplaceId] = {
        avg: r.avg,
        n: r.n,
        currency: r.currency,
        query: r.query,
      };
      if (r.n > 0) anyPlayerAthleteMatch = true;
    }

    // Skip if no Player/Athlete match anywhere (per your rule)
    if (!anyPlayerAthleteMatch) {
      console.log(`${a.name}: SKIPPED (no Player/Athlete match)`);
      continue;
    }

    // Primary values used by frontend label:
    // prefer EBAY_CA because it tends to be CAD; fall back to null if missing
    const ca = byMp.EBAY_CA || null;
    const primaryAvg = ca?.avg ?? null;
    const primaryN = ca?.n ?? 0;
    const primaryCurrency = ca?.currency ?? "CAD";

    out[a.name] = {
      avg: primaryAvg, // active listing avg (primary=CA)
      n: primaryN,
      currency: primaryCurrency,
      marketplaces: {
        EBAY_CA: {
          avg: byMp.EBAY_CA?.avg ?? null,
          n: byMp.EBAY_CA?.n ?? 0,
          currency: byMp.EBAY_CA?.currency ?? "CAD",
        },
        EBAY_US: {
          avg: byMp.EBAY_US?.avg ?? null,
          n: byMp.EBAY_US?.n ?? 0,
          currency: byMp.EBAY_US?.currency ?? "USD",
        },
      },
      asOf,
    };
  }

  await writeJsonPretty(OUT_PATH, out);
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
