// scripts/update-ebay-avg.js
// Node 20+ (uses global fetch)
// Computes:
// - avg sold price (Marketplace Insights item_sales/search)
// - avg active listing price (Browse item_summary/search) -- Buy It Now only
// Dual marketplace: EBAY_US + EBAY_CA
//
// Env vars required:
//   EBAY_CLIENT_ID
//   EBAY_CLIENT_SECRET
//
// Output:
//   data/ebay-avg.json
//
// Notes:
// - We validate Player/Athlete by actually trying an aspect_filter query.
//   This avoids missing names that don't appear in the refinement list.
// - We do NOT exclude graded and we do NOT exclude <$1 items.

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

// Your repo already has a list of athletes somewhere.
// This script expects:
//   data/athletes.json: [{ name: "Jose Altuve", sport: "baseball" }, ...]
//
// If your file differs, adjust loadAthletes() accordingly.
const ATHLETES_PATH = path.join(__dirname, "..", "data", "athletes.json");

// Category you were using (Trading Card Singles)
const CATEGORY_ID = "261328";

// Sampling / thresholds
const MIN_EBAY_SAMPLE_SIZE = 5;          // sold comps minimum
const SOLD_LOOKBACK_DAYS = 90;           // Insights defaults vary; we filter by date range
const SOLD_PAGE_LIMIT = 200;             // max sold records to average per marketplace
const LISTING_PAGE_LIMIT = 200;          // max active listings to average per marketplace
const PAGE_SIZE = 50;

// Marketplaces to compute
const MARKETPLACES = ["EBAY_US", "EBAY_CA"];

// ------------ helpers ------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normName(s) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuery(name, sport) {
  // Include sport word(s) lightly — helps reduce false matches
  // while still allowing broad inventory.
  const sportHint = sport ? ` ${sport}` : "";
  // “card” helps reduce non-card collectibles while still allowing graded.
  return `${name}${sportHint} card`;
}

function formatDateYYYYMMDD(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dateRangeFilter(days) {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  // Insights filter uses itemStartDate / itemEndDate style in some APIs;
  // Marketplace Insights uses "soldDate" filters as "soldDate:[start..end]".
  const start = formatDateYYYYMMDD(past);
  const end = formatDateYYYYMMDD(now);
  return `soldDate:[${start}..${end}]`;
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

function getHeaderMarketplace(marketplaceId) {
  return {
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
  };
}

// ------------ ebay auth ------------

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
      // Browse + Marketplace Insights
      scope: [
        "https://api.ebay.com/oauth/api_scope",
        "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights",
      ].join(" "),
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

// ------------ ebay calls ------------

async function ebayBrowseSearch({ token, marketplaceId, q, categoryId, limit, offset, aspectFilter }) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("category_ids", categoryId);

  // Buy It Now only (exclude auctions)
  url.searchParams.append("filter", "buyingOptions:{FIXED_PRICE}");

  if (aspectFilter) {
    // aspect_filter format: "Player/Athlete:{Jose Altuve}"
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

async function ebayInsightsSoldSearch({ token, marketplaceId, q, categoryId, limit, offset, aspectFilter, soldDateFilter }) {
  const url = new URL("https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("category_ids", categoryId);

  // Sold date range
  if (soldDateFilter) url.searchParams.append("filter", soldDateFilter);

  // We still want to avoid auctions for sold comps too if possible.
  // Marketplace insights supports buyingOptions in filters.
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
    throw new Error(`Insights sold search failed (${marketplaceId}) ${res.status}: ${txt}`);
  }

  return res.json();
}

// ------------ matching / validation ------------

function candidateAspectValuesForName(name) {
  // Try variants that often appear in eBay aspect values.
  // This is specifically to avoid false SKIPPED when accents/suffix differ.
  const raw = (name || "").trim();
  const ascii = normName(raw);

  const variants = new Set([
    raw,
    ascii,
    raw.replace(/\./g, ""),
    ascii.replace(/\./g, ""),
    raw.replace(/\s+Jr\.?$/i, "").trim(),
    ascii.replace(/\s+Jr\.?$/i, "").trim(),
  ]);

  // Remove double spaces etc.
  return [...variants].map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean);
}

async function validatePlayerAthleteMatch({ token, marketplaceId, name, sport }) {
  // Instead of relying on refinement distributions (which can omit long-tail names),
  // we test whether aspect_filter=Player/Athlete:{<name>} returns ANY results.
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
    if (total > 0) {
      return { ok: true, aspectValue: cand };
    }

    // small delay to be polite
    await sleep(120);
  }

  return { ok: false, aspectValue: null };
}

// ------------ computations ------------

async function computeAvgActiveListing({ token, marketplaceId, name, sport, aspectValue }) {
  const q = buildQuery(name, sport);
  const aspectFilter = aspectValue ? `Player/Athlete:{${aspectValue}}` : null;

  let offset = 0;
  const prices = [];
  let currency = null;

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
      const p = it?.price;
      const v = safeNum(p?.value);
      if (v == null) continue;
      prices.push(v);
      currency = currency || p?.currency;
    }

    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(120);
  }

  return {
    avgListing: avg(prices),
    nListing: prices.length,
    currency: currency || null,
  };
}

async function computeAvgSold({ token, marketplaceId, name, sport, aspectValue }) {
  const q = buildQuery(name, sport);
  const aspectFilter = aspectValue ? `Player/Athlete:{${aspectValue}}` : null;

  let offset = 0;
  const prices = [];
  let currency = null;

  const soldDateFilter = dateRangeFilter(SOLD_LOOKBACK_DAYS);

  while (offset < SOLD_PAGE_LIMIT) {
    const data = await ebayInsightsSoldSearch({
      token,
      marketplaceId,
      q,
      categoryId: CATEGORY_ID,
      limit: PAGE_SIZE,
      offset,
      aspectFilter,
      soldDateFilter,
    });

    const items = data?.itemSales || data?.itemSummaries || [];
    // Marketplace insights response uses itemSales[] with price info
    for (const it of items) {
      const p = it?.price || it?.soldPrice || it?.currentBidPrice;
      const v = safeNum(p?.value);
      if (v == null) continue;
      prices.push(v);
      currency = currency || p?.currency;
    }

    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(150);
  }

  return {
    avgSold: avg(prices),
    nSold: prices.length,
    currency: currency || null,
  };
}

// ------------ data loading ------------

function loadAthletes() {
  if (!fs.existsSync(ATHLETES_PATH)) {
    throw new Error(
      `Missing ${ATHLETES_PATH}. Create data/athletes.json with [{name,sport}, ...] or adjust script.`
    );
  }
  const raw = fs.readFileSync(ATHLETES_PATH, "utf8");
  const arr = JSON.parse(raw);

  // Normalize to { name, sport }
  return (arr || [])
    .map((x) => ({
      name: x?.name?.trim(),
      sport: (x?.sport || "").trim().toLowerCase(),
    }))
    .filter((x) => x.name);
}

// ------------ main ------------

async function main() {
  const token = await getAppToken();

  const athletes = loadAthletes();

  // Output structure:
  // {
  //   byName: {
  //     "Jose Altuve": {
  //       marketplaces: {
  //         EBAY_CA: { avgSold, nSold, avgListing, nListing, currency, aspectValue },
  //         EBAY_US: { ... }
  //       },
  //       // convenience rollups (prefer CAD from EBAY_CA if available)
  //       avgSold: number|null,
  //       nSold: number,
  //       avgListing: number|null,
  //       nListing: number,
  //       currency: "CAD"|...
  //     }
  //   },
  //   updatedAt: ISO string
  // }
  const out = {
    byName: {},
    updatedAt: new Date().toISOString(),
  };

  for (let i = 0; i < athletes.length; i++) {
    const { name, sport } = athletes[i];
    console.log(`[${i + 1}/${athletes.length}] ${name}`);

    out.byName[name] = out.byName[name] || { marketplaces: {} };

    // Validate on at least one marketplace first.
    // We'll try CA first (since you display CAD in UI), then US.
    let validated = null;

    for (const marketplaceId of ["EBAY_CA", "EBAY_US"]) {
      const v = await validatePlayerAthleteMatch({ token, marketplaceId, name, sport });
      if (v.ok) {
        validated = { marketplaceId, aspectValue: v.aspectValue };
        break;
      }
    }

    if (!validated) {
      console.log(`${name}: SKIPPED (no Player/Athlete match via aspect_filter test)`);
      delete out.byName[name];
      continue;
    }

    // Once we have an aspectValue that works, we can use it across both marketplaces.
    const aspectValue = validated.aspectValue;

    for (const marketplaceId of MARKETPLACES) {
      try {
        const [sold, listing] = await Promise.all([
          computeAvgSold({ token, marketplaceId, name, sport, aspectValue }),
          computeAvgActiveListing({ token, marketplaceId, name, sport, aspectValue }),
        ]);

        out.byName[name].marketplaces[marketplaceId] = {
          aspectValue,
          avgSold: sold.avgSold,
          nSold: sold.nSold,
          avgListing: listing.avgListing,
          nListing: listing.nListing,
          currency: (sold.currency || listing.currency || null),
        };
      } catch (e) {
        console.log(`${name} (${marketplaceId}): ERROR ${e?.message || e}`);
        // keep going; partial results are ok
      }
    }

    // Convenience rollup for your UI (prefer EBAY_CA if CAD present)
    const ca = out.byName[name].marketplaces.EBAY_CA;
    const us = out.byName[name].marketplaces.EBAY_US;

    const pick =
      (ca && ca.currency === "CAD" ? ca : null) ||
      (ca && ca.avgSold != null ? ca : null) ||
      (us && us.avgSold != null ? us : null) ||
      ca ||
      us;

    out.byName[name].avgSold = pick?.avgSold ?? null;
    out.byName[name].nSold = pick?.nSold ?? 0;
    out.byName[name].avgListing = pick?.avgListing ?? null;
    out.byName[name].nListing = pick?.nListing ?? 0;
    out.byName[name].currency = pick?.currency ?? null;

    // If sample size too small, keep record but your UI can ignore it.
    if (out.byName[name].nSold < MIN_EBAY_SAMPLE_SIZE) {
      // leave it; UI logic already handles MIN_EBAY_SAMPLE_SIZE
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
